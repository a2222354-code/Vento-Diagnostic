package com.vag.kw1281

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.util.ArrayDeque

/**
 * Высокоточный аппаратный драйвер FTDI FT232 для шины K-Line / VAG KWP1281.
 * 
 * Реализовано в строгом соответствии с декомпилированным нативным протоколом:
 * 1. Управление уровнем TX через Bit-Bang (SIO_SET_BITMODE) и SetBreak.
 * 2. 5-бодовая посылка по абсолютному дедлайну 200.0 мс на бит (LSB first, odd parity).
 * 3. Пауза перед стартом ~250 мс, стоп-бит 200 мс, затем дополнительная пауза 20 мс до перехода в UART.
 * 4. Удержание сигналов DTR и RTS в активном состоянии (питание приёмопередатчика K-Line).
 * 5. Буферизация FTDI через 256-байтный буфер (обход ограничения 2-байтного заголовка модема).
 * 6. Побайтовое подтверждение с фильтрацией KKL loopback-эхо (функция isEchoOrComplement).
 */
class Ftdi5BaudDriver(
    private val usbManager: UsbManager,
    private val device: UsbDevice
) {
    private var connection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null
    private var isBitBangActive = false

    private val rxQueue = ArrayDeque<Byte>()
    var lastError: String? = null
        private set

    companion object {
        private const val BIT_TIME_NANOS = 200_000_000L // 200.0 мс = 5 бод
    }

    suspend fun open(baud: Int = 9600): Boolean = withContext(Dispatchers.IO) {
        try {
            close()
            lastError = null

            connection = usbManager.openDevice(device) ?: run {
                lastError = "Не удалось открыть USB подключение"
                return@withContext false
            }

            val prober = try {
                UsbSerialProber.getDefaultProber().probeDevice(device)
            } catch (t: Throwable) {
                null
            }
            val driver = prober ?: FtdiSerialDriver(device)
            if (driver.ports.isEmpty()) {
                lastError = "COM порт не обнаружен в драйвере"
                return@withContext false
            }

            val p = driver.ports[0]
            port = p
            p.open(connection)

            // Устанавливаем режим UART 8N1
            setUartMode(baud)

            // Первичная очистка буферов
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

    /**
     * Перевод чипа FTDI в режим Asynchronous Bit-Bang (управление выводом TX)
     */
    fun setBitBangMode() {
        isBitBangActive = true
        try {
            // SIO_SET_BITMODE (0x0B): wValue = (mask << 8) | mode
            // mask = 0x01 (TXD pin as output), mode = 0x01 (Async Bitbang)
            connection?.controlTransfer(0x40, 0x0B, 0x0101, 1, null, 0, 100)
        } catch (t: Throwable) {}
        try {
            port?.setDTR(true)
            port?.setRTS(true)
        } catch (t: Throwable) {}
    }

    /**
     * Установка физического состояния линии TX:
     * high = true  -> Mark (линия K-Line 12 В, неактивна)
     * high = false -> Space (линия K-Line 0 В, активна)
     */
    fun setPinState(high: Boolean) {
        if (isBitBangActive) {
            try {
                port?.write(if (high) byteArrayOf(0x01) else byteArrayOf(0x00), 50)
            } catch (t: Throwable) {}
        }
        try {
            // Дублируем через break state для надёжности на любых типах адаптеров
            port?.setBreak(!high)
        } catch (t: Throwable) {}
    }

    /**
     * Возврат чипа FTDI в стандартный режим UART (8N1)
     */
    fun setUartMode(baud: Int = 9600) {
        isBitBangActive = false
        try {
            // SIO_SET_BITMODE (0x0B): wValue = 0x0000 (Mode 0: Reset to normal UART)
            connection?.controlTransfer(0x40, 0x0B, 0x0000, 1, null, 0, 100)
        } catch (t: Throwable) {}
        try {
            port?.setBreak(false)
            port?.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            port?.setDTR(true)
            port?.setRTS(true)
        } catch (t: Throwable) {}
    }

    /**
     * Посылка 5-бодовой последовательности инициализации адреса ЭБУ
     * по абсолютному дедлайну согласно спецификации KWP1281.
     */
    suspend fun send5BaudInitAddress(
        address: Int = 0x01,
        targetBaud: Int = 9600,
        onLog: (String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext false
        onLog("Инициализация K-Line (DTR/RTS активны, пауза 250 мс)...")

        try {
            // 1. Переводим адаптер в bit-bang, TX = HIGH (idle)
            setBitBangMode()
            setPinState(true)

            // 2. Пауза перед стартом: ~250 мс
            Thread.sleep(250)

            onLog("5 бод: посылка адреса 0x%02X (200.0 мс/бит, 7O1)...".format(address))

            var targetNanos = System.nanoTime()

            fun waitBitDeadline() {
                targetNanos += BIT_TIME_NANOS
                while (System.nanoTime() < targetNanos) {
                    val remainingMs = (targetNanos - System.nanoTime()) / 1_000_000L
                    if (remainingMs > 15) {
                        try {
                            Thread.sleep(remainingMs - 10)
                        } catch (e: InterruptedException) {}
                    }
                }
            }

            // 3. Старт-бит: TX = LOW (0 В), 200 мс
            setPinState(false)
            waitBitDeadline()

            // 4. 7 бит адреса, LSB first, по 200 мс каждый
            var parity = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                parity = parity xor bit
                setPinState(bit == 1)
                waitBitDeadline()
            }

            // 5. Бит чётности: TX = !(parity) -> нечётная чётность (odd), 200 мс
            // Для 0x01 (единиц=1, parity=1) -> !(1) = 0 -> LOW
            val parityBit = if (parity != 0) 0 else 1
            setPinState(parityBit == 1)
            waitBitDeadline()

            // 6. Стоп-бит: TX = HIGH (12 В), ровно 200 мс
            setPinState(true)
            waitBitDeadline()

            // 7. Дополнительная пауза после стопа: 20 мс
            Thread.sleep(20)

            // 8. Переключение в UART (8N1, 9600 бод)
            setUartMode(targetBaud)

            // 9. Очищаем очередь приёма и аппаратные буферы от следов break
            synchronized(rxQueue) {
                rxQueue.clear()
            }
            try {
                p.purgeHwBuffers(true, true)
            } catch (t: Throwable) {}

            onLog("5-бодовая посылка завершена. Линия переключена на $targetBaud бод 8N1.")
            true
        } catch (t: Throwable) {
            lastError = "${t.javaClass.simpleName}: ${t.message}"
            onLog("Ошибка 5-бодовой посылки: ${t.message ?: t.javaClass.simpleName}")
            false
        }
    }

    /**
     * Побайтовое чтение из FTDI с таймаутом через 256-байтный буфер
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
     * Отправка байта с подтверждением инверсией от ЭБУ (~byte)
     * и корректной фильтрацией собственного loopback-эхо K-Line (алгоритм isEchoOrComplement).
     */
    suspend fun writeByteAndVerifyAck(b: Byte, timeoutMs: Int = 300, maxRetries: Int = 4): Boolean = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext false
        val sentVal = b.toInt() and 0xFF
        val compExpected = (sentVal xor 0xFF) and 0xFF

        for (attempt in 1..maxRetries) {
            try {
                p.write(byteArrayOf(b), timeoutMs)
            } catch (t: Throwable) {
                lastError = "${t.javaClass.simpleName}: ${t.message}"
                return@withContext false
            }

            val start = System.currentTimeMillis()
            var gotEcho = false

            while (System.currentTimeMillis() - start < timeoutMs) {
                val rx = readByte(timeoutMs)
                if (rx < 0) continue

                // 1. Проверяем, не является ли байт нашим собственным эхо на K-Line
                if (!gotEcho && rx == sentVal) {
                    gotEcho = true
                    continue // Эхо принято и отброшено, ждем ответ ЭБУ
                }

                // 2. Проверяем, является ли байт побитовой инверсией (~byte)
                if (rx == compExpected) {
                    // Успешное подтверждение от ЭБУ
                    delay(3) // Межбайтная пауза ~3 мс по спецификации KWP1281
                    return@withContext true
                }
            }
            delay(5)
        }
        return@withContext false
    }

    /**
     * Отправка завершающего байта блока 0x03 (не подтверждается инверсией)
     */
    suspend fun sendEndMarker(timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        try {
            p.write(byteArrayOf(0x03), timeoutMs)
            // Отбрасываем возможное loopback-эхо от 0x03
            readByte(40)
            delay(6) // Межблочная пауза ~5–8 мс по спецификации KWP1281
        } catch (t: Throwable) {}
    }

    /**
     * Отправка байта без подтверждения (для инверсии ~KW2 или подтверждения входящего байта)
     */
    suspend fun writeRawByte(b: Byte, timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        try {
            p.write(byteArrayOf(b), timeoutMs)
            // Отбрасываем собственное loopback-эхо
            readByte(40)
        } catch (t: Throwable) {}
    }

    fun clearBuffers() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
        try {
            port?.purgeHwBuffers(true, true)
        } catch (t: Throwable) {}
    }

    fun close() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
        try {
            setUartMode(9600)
        } catch (t: Throwable) {}
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
