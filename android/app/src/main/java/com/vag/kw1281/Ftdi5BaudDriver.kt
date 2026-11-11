package com.vag.kw1281

import android.content.res.ColorStateList
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Высокоточный и отказоустойчивый драйвер K-Line / FTDI FT232 для KW1281.
 * 
 * Особенности:
 * 1. 5 бод = ровно 200.0 мс на бит с защитой от таймингового джиттера Android Linux.
 * 2. Безопасное включение DTR/RTS для питания и разрешения трансивера K-Line.
 * 3. 300 мс пассивного состояния (Mark, Break=false) перед старт-битом.
 * 4. Полная защита от вылетов (все обращения к USB закрыты try-catch Throwable).
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
            close() // Безопасно закрываем предыдущее соединение перед открытием нового

            connection = usbManager.openDevice(device) ?: return@withContext false
            val proberDriver = try {
                UsbSerialProber.getDefaultProber().probeDevice(device)
            } catch (t: Throwable) {
                null
            }
            val driver = proberDriver ?: FtdiSerialDriver(device)
            if (driver.ports.isEmpty()) return@withContext false
            
            val p = driver.ports[0]
            port = p
            p.open(connection)

            // Активируем линии DTR и RTS с защитой от отсутствия метода
            try {
                p.setDTR(true)
                p.setRTS(true)
            } catch (t: Throwable) {}

            try {
                p.setParameters(initialBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            } catch (t: Throwable) {}

            true
        } catch (t: Throwable) {
            t.printStackTrace()
            false
        }
    }

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
                    // Игнорируем прерывание, докручиваем в цикле
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
        onLog("Подготовка K-Line (300 мс Idle)...")

        try {
            // 1. Пауза не менее 300 мс в состоянии Mark (Break = false)
            try { p.setBreak(false) } catch (t: Throwable) {}
            Thread.sleep(300)

            onLog("5 бод: посылка адреса 0x%02X (200 мс/бит)...".format(address))
            val waiter = CycleWaiter(BIT_TIME_NANOS)

            // 2. Старт-бит: Space (0) -> Break = true
            try { p.setBreak(true) } catch (t: Throwable) {}
            waiter.waitNext()

            // 3. 7 бит данных LSB first
            var onesCount = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                if (bit == 1) {
                    onesCount++
                    try { p.setBreak(false) } catch (t: Throwable) {}
                } else {
                    try { p.setBreak(true) } catch (t: Throwable) {}
                }
                waiter.waitNext()
            }

            // 4. Бит четности (Odd Parity для KW1281)
            val parityBit = if (onesCount % 2 != 0) 0 else 1
            try { p.setBreak(parityBit == 0) } catch (t: Throwable) {}
            waiter.waitNext()

            // 5. Стоп-бит: Mark (1) -> Break = false
            try { p.setBreak(false) } catch (t: Throwable) {}
            waiter.waitNext()

            // 6. Переключаем UART на рабочую скорость
            try {
                p.setParameters(targetBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            } catch (t: Throwable) {
                onLog("Предупреждение: не удалось установить скорость $targetBaud бод")
            }

            // 7. Очищаем FIFO буфер FTDI от мусора после Break
            try {
                p.purgeHwBuffers(true, true)
            } catch (t: Throwable) {}

            val drainBuf = ByteArray(256)
            var drainTries = 0
            while (drainTries < 10) {
                val readLen = try { p.read(drainBuf, 10) } catch (t: Throwable) { 0 }
                if (readLen <= 0) break
                drainTries++
            }

            onLog("5-бодовая посылка завершена. Ожидание ответа ЭБУ...")
            true
        } catch (t: Throwable) {
            onLog("Ошибка 5-бодовой посылки: ${t.message ?: t.javaClass.simpleName}")
            false
        }
    }

    suspend fun readByte(timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext -1
        try {
            val buf = ByteArray(1)
            val readLen = p.read(buf, timeoutMs)
            if (readLen > 0) {
                buf[0].toInt() and 0xFF
            } else {
                -1
            }
        } catch (t: Throwable) {
            -1
        }
    }

    suspend fun readBytes(buffer: ByteArray, timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext -1
        try {
            p.read(buffer, timeoutMs)
        } catch (t: Throwable) {
            -1
        }
    }

    suspend fun writeByteAndDiscardEcho(b: Byte, timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        try {
            p.write(byteArrayOf(b), timeoutMs)
            val echo = ByteArray(1)
            p.read(echo, 150)
        } catch (t: Throwable) {}
    }

    suspend fun writeBytesAndDiscardEcho(data: ByteArray, timeoutMs: Int = 500) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        for (b in data) {
            writeByteAndDiscardEcho(b, timeoutMs)
        }
    }

    fun close() {
        try {
            port?.close()
        } catch (t: Throwable) {}
        try {
            connection?.close()
        } catch (t: Throwable) {}
        port = null
        connection = null
    }
}
