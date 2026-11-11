package com.vag.kw1281

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.ArrayDeque

/**
 * Высокоточный и надежный драйвер K-Line / FTDI FT232 для KW1281.
 * 
 * ВАЖНО для FTDI в usb-serial-for-android:
 * 1. p.read(...) требует буфер длиной более 2 байт (из-за 2 байт заголовка статуса модема FTDI).
 *    Чтение одиночных байт реализовано через очередь rxQueue и буфер 256 байт.
 * 2. Для корректной работы приёмопередатчика K-Line (L9637D / MC33199 / транзисторы)
 *    необходимо удерживать сигналы DTR и RTS в активном состоянии (true), как в VAG-COM на ПК.
 * 3. Переключение на рабочую скорость (9600/10400) и очистка мусора от Break производятся
 *    в середине стоп-бита (когда линия гарантированно свободна), чтобы ни в коем случае
 *    не стереть входящий байт 0x55 от ЭБУ.
 */
class Ftdi5BaudDriver(
    private val usbManager: UsbManager,
    private val device: UsbDevice
) {
    private var connection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null

    // Очередь для побайтового чтения
    private val rxQueue = ArrayDeque<Byte>()
    var lastError: String? = null
        private set

    companion object {
        private const val BIT_TIME_NANOS = 200_000_000L // 200 мс = 5 бод
    }

    suspend fun open(initialBaud: Int = 9600): Boolean = withContext(Dispatchers.IO) {
        try {
            close()
            lastError = null

            connection = usbManager.openDevice(device) ?: run {
                lastError = "Не удалось открыть соединение UsbDeviceConnection"
                return@withContext false
            }

            val proberDriver = try {
                UsbSerialProber.getDefaultProber().probeDevice(device)
            } catch (t: Throwable) {
                null
            }
            val driver = proberDriver ?: FtdiSerialDriver(device)
            if (driver.ports.isEmpty()) {
                lastError = "Устройство не содержит доступных COM-портов"
                return@withContext false
            }
            
            val p = driver.ports[0]
            port = p
            p.open(connection)

            try {
                p.setParameters(initialBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            } catch (t: Throwable) {}

            // Активируем сигналы DTR и RTS (необходимо для питания и включения микросхемы K-Line)
            try { p.setDTR(true) } catch (t: Throwable) {}
            try { p.setRTS(true) } catch (t: Throwable) {}

            // Первичный сброс буферов
            try { p.purgeHwBuffers(true, true) } catch (t: Throwable) {}
            synchronized(rxQueue) {
                rxQueue.clear()
            }

            true
        } catch (t: Throwable) {
            lastError = "${t.javaClass.simpleName}: ${t.message}"
            t.printStackTrace()
            false
        }
    }

    fun clearRxQueue() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
    }

    private class CycleWaiter(private val periodNanos: Long) {
        private var nextTargetNanos = System.nanoTime()

        fun waitNext() {
            nextTargetNanos += periodNanos
            val now = System.nanoTime()
            val remainingMs = (nextTargetNanos - now) / 1_000_000L
            if (remainingMs > 15) {
                try {
                    Thread.sleep(remainingMs - 10)
                } catch (e: InterruptedException) {}
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
        onLog("Подготовка K-Line (DTR/RTS ВКЛ, пауза 400 мс)...")

        try {
            // Убеждаемся, что модемные линии активны, а линия K-Line в покое (Mark, +12V)
            try { p.setDTR(true) } catch (t: Throwable) {}
            try { p.setRTS(true) } catch (t: Throwable) {}
            try { p.setBreak(false) } catch (t: Throwable) {}
            Thread.sleep(400)

            onLog("5 бод: посылка адреса 0x%02X (200 мс/бит)...".format(address))
            val waiter = CycleWaiter(BIT_TIME_NANOS)

            // 1. Старт-бит: Space (0) -> Break = true (0V)
            try { p.setBreak(true) } catch (t: Throwable) {}
            waiter.waitNext()

            // 2. 7 бит данных LSB first
            var onesCount = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                if (bit == 1) {
                    onesCount++
                    try { p.setBreak(false) } catch (t: Throwable) {} // Mark (12V)
                } else {
                    try { p.setBreak(true) } catch (t: Throwable) {}  // Space (0V)
                }
                waiter.waitNext()
            }

            // 3. Бит четности (Odd Parity для KW1281)
            // Общее число единиц (данные + parity) должно быть нечётным.
            // Для 0x01 (одна единица) бит parity = 0 (Space).
            val parityBit = if (onesCount % 2 != 0) 0 else 1
            try { p.setBreak(parityBit == 0) } catch (t: Throwable) {}
            waiter.waitNext()

            // 4. Стоп-бит: Mark (1) -> Break = false (12V)
            try { p.setBreak(false) } catch (t: Throwable) {}
            
            // Выжидаем первые 100 мс стоп-бита
            Thread.sleep(100)

            // В середине стоп-бита (линия гарантированно в покое) конфигурируем рабочую скорость UART
            try {
                p.setParameters(targetBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                p.setDTR(true)
                p.setRTS(true)
            } catch (t: Throwable) {
                onLog("Предупреждение UART: ${t.message}")
            }

            // Очищаем эхо/мусор от Break до того, как ЭБУ начнет отвечать
            synchronized(rxQueue) {
                rxQueue.clear()
            }
            try {
                p.purgeHwBuffers(true, true)
            } catch (t: Throwable) {}

            // Выжидаем оставшиеся 100 мс стоп-бита
            Thread.sleep(100)

            onLog("5-бодовая посылка завершена. Ожидание ответа ЭБУ...")
            true
        } catch (t: Throwable) {
            lastError = "${t.javaClass.simpleName}: ${t.message}"
            onLog("Ошибка 5-бодовой посылки: ${t.message ?: t.javaClass.simpleName}")
            false
        }
    }

    /**
     * Чтение одного байта с таймаутом через 256-байтный буфер (требование FTDI драйвера)
     */
    suspend fun readByte(timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext -1

        synchronized(rxQueue) {
            if (rxQueue.isNotEmpty()) {
                return@withContext rxQueue.removeFirst().toInt() and 0xFF
            }
        }

        val start = System.currentTimeMillis()
        val tempBuf = ByteArray(256)

        while (System.currentTimeMillis() - start < timeoutMs) {
            try {
                val readLen = p.read(tempBuf, 40)
                if (readLen > 0) {
                    synchronized(rxQueue) {
                        for (i in 0 until readLen) {
                            rxQueue.addLast(tempBuf[i])
                        }
                        if (rxQueue.isNotEmpty()) {
                            return@withContext rxQueue.removeFirst().toInt() and 0xFF
                        }
                    }
                }
            } catch (t: Throwable) {
                lastError = "${t.javaClass.simpleName}: ${t.message}"
            }
        }
        return@withContext -1
    }

    /**
     * Чтение нескольких байт в буфер
     */
    suspend fun readBytes(buffer: ByteArray, timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        if (buffer.isEmpty()) return@withContext 0
        var count = 0
        val start = System.currentTimeMillis()
        while (count < buffer.size && (System.currentTimeMillis() - start < timeoutMs)) {
            val remainingTimeout = (timeoutMs - (System.currentTimeMillis() - start)).toInt().coerceAtLeast(20)
            val b = readByte(remainingTimeout)
            if (b >= 0) {
                buffer[count] = b.toByte()
                count++
            } else {
                break
            }
        }
        return@withContext count
    }

    /**
     * Отправка байта с подавлением отражённого эхо K-Line
     */
    suspend fun writeByteAndDiscardEcho(b: Byte, timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        try {
            p.write(byteArrayOf(b), timeoutMs)
            // K-Line Loopback эхо: считываем и сбрасываем отражённый байт
            readByte(100)
        } catch (t: Throwable) {}
    }

    suspend fun writeBytesAndDiscardEcho(data: ByteArray, timeoutMs: Int = 500) = withContext(Dispatchers.IO) {
        for (b in data) {
            writeByteAndDiscardEcho(b, timeoutMs)
        }
    }

    fun close() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
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
