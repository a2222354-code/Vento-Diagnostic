package com.vag.kw1281

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Высокоточный драйвер K-Line / FTDI FT232 для KW1281.
 * 
 * Особенности:
 * 1. 5 бод = ровно 200.0 мс на бит с защитой от таймингового джиттера Android Linux.
 * 2. Активация DTR/RTS для питания и разрешения трансивера K-Line (L9637D/SI9243).
 * 3. 300 мс пассивного состояния (Mark, Break=false) перед старт-битом.
 * 4. Сброс аппаратного FIFO буфера FTDI после 5-бодовой посылки для очистки мусора от Break.
 * 5. Подавление полудуплексного эха (K-Line Loopback Echo Discard) при отправке байт.
 */
class Ftdi5BaudDriver(
    private val usbManager: UsbManager,
    private val device: UsbDevice
) {
    private var connection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null

    companion object {
        private const val BIT_TIME_NANOS = 200_000_000L // 200 мс = 5 бод
    }

    suspend fun open(initialBaud: Int = 9600): Boolean = withContext(Dispatchers.IO) {
        try {
            connection = usbManager.openDevice(device) ?: return@withContext false
            val driver = UsbSerialProber.getDefaultProber().probeDevice(device) ?: FtdiSerialDriver(device)
            if (driver.ports.isEmpty()) return@withContext false
            port = driver.ports[0]
            port?.open(connection)

            // Активируем линии DTR и RTS — на многих адаптерах VAG KKL 409.1
            // они питают оптопары или активируют схему согласования уровней K-Line
            try {
                port?.dtr = true
                port?.rts = true
            } catch (e: Exception) {}

            port?.setParameters(initialBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Прецизионное ожидание для предотвращения джиттера шедулера Linux
     */
    private class CycleWaiter(private val periodNanos: Long) {
        private var nextTargetNanos = System.nanoTime()

        fun waitNext() {
            nextTargetNanos += periodNanos
            val now = System.nanoTime()
            val remainingMs = (nextTargetNanos - now) / 1_000_000L
            if (remainingMs > 4) {
                try {
                    Thread.sleep(remainingMs - 2)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                }
            }
            while (System.nanoTime() < nextTargetNanos) {
                // Плотный цикл для идеальной микросекундной точности 200.0 мс
            }
        }
    }

    suspend fun send5BaudInitAddress(
        address: Int = 0x01,
        targetBaud: Int = 9600,
        onLog: (String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext false
        onLog("Подготовка линии K-Line (300 мс Idle)...")

        try {
            // 1. Пауза не менее 300 мс в состоянии Mark (Break = false), чтобы ЭБУ зафиксировал высокий уровень
            p.setBreak(false)
            Thread.sleep(300)

            // Холостой вызов для устранения начальной задержки драйвера ядра FTDI
            p.setBreak(false)

            onLog("Отправка адреса 0x%02X на скорости 5 бод (200.0 мс/бит)...".format(address))
            val waiter = CycleWaiter(BIT_TIME_NANOS)

            // 2. Старт-бит: Space (0) -> Break = true
            p.setBreak(true)
            waiter.waitNext()

            // 3. 7 бит данных LSB first
            var onesCount = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                if (bit == 1) {
                    onesCount++
                    p.setBreak(false) // Mark (1)
                } else {
                    p.setBreak(true) // Space (0)
                }
                waiter.waitNext()
            }

            // 4. Бит четности (Odd Parity для KW1281):
            // Сумма единиц в 7 битах + бит четности должна быть нечетной
            val parityBit = if (onesCount % 2 != 0) 0 else 1
            p.setBreak(parityBit == 0) // если 0 -> Space (Break=true), если 1 -> Mark (Break=false)
            waiter.waitNext()

            // 5. Стоп-бит: Mark (1) -> Break = false
            p.setBreak(false)
            waiter.waitNext()

            // 6. Удержание стоп-бита завершено (2000 мс суммарно). Переключаем UART на рабочую скорость
            p.setParameters(targetBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)

            // 7. Критически важно: очищаем FIFO буфер FTDI от мусора и нулей, возникших из-за Break
            try {
                p.purgeHwBuffers(true, true)
            } catch (e: Exception) {}

            val drainBuf = ByteArray(256)
            var drainTries = 0
            while (drainTries < 10) {
                val readLen = p.read(drainBuf, 10)
                if (readLen <= 0) break
                drainTries++
            }

            onLog("5-бодовая посылка завершена. Буфер очищен. Скорость $targetBaud бод.")
            true
        } catch (e: Exception) {
            onLog("Ошибка при 5-бодовой посылке: ${e.message}")
            false
        }
    }

    /**
     * Чтение одного байта с таймаутом
     */
    suspend fun readByte(timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext -1
        val buf = ByteArray(1)
        val readLen = p.read(buf, timeoutMs)
        if (readLen > 0) {
            buf[0].toInt() and 0xFF
        } else {
            -1
        }
    }

    /**
     * Отправка одного байта с подавлением полудуплексного эха K-Line.
     * На однопроводной линии K-Line переданный байт сразу же возвращается в приёмник.
     * Этот метод считывает и отбрасывает отражённый эхо-байт.
     */
    suspend fun writeByteAndDiscardEcho(b: Byte, timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        p.write(byteArrayOf(b), timeoutMs)
        val echo = ByteArray(1)
        p.read(echo, 150)
    }

    /**
     * Отправка нескольких байт с подавлением эха каждого байта
     */
    suspend fun writeBytesAndDiscardEcho(data: ByteArray, timeoutMs: Int = 500) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        for (b in data) {
            writeByteAndDiscardEcho(b, timeoutMs)
        }
    }

    fun close() {
        try {
            port?.close()
            connection?.close()
        } catch (e: Exception) {}
    }
}
