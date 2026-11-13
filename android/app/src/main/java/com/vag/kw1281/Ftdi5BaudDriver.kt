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
 * Ключевые особенности надёжности:
 * 1. 5-бодовая посылка формируется через стандартный аппаратный Break (setBreak).
 * 2. Абсолютный дедлайн 200.0 мс на бит (start + N * 200ms) без накопления ошибки.
 * 3. Пауза 250 мс перед стартом, стоп-бит 200 мс, пауза 25 мс до чтения ответа.
 * 4. Удержание линий DTR/RTS (питание трансивера K-Line) и FTDI Latency Timer = 2 мс.
 * 5. Буферизация FTDI через 256-байтный буфер с поддержкой unreadByte (возврат чужого байта в очередь).
 * 6. Фильтрация однопроводного K-Line эхо (isEchoOrComplement) без потери входящих байтов от ЭБУ.
 */
class Ftdi5BaudDriver(
    private val usbManager: UsbManager,
    private val device: UsbDevice
) {
    private var connection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null

    private val rxQueue = ArrayDeque<Byte>()
    var lastError: String? = null
        private set

    val isOpen: Boolean
        get() = port?.isOpen == true && connection != null

    companion object {
        private const val BIT_DURATION_NANOS = 200_000_000L // 200.0 мс = 5 бод
    }

    suspend fun open(baud: Int = 9600): Boolean = withContext(Dispatchers.IO) {
        try {
            close()
            lastError = null

            connection = usbManager.openDevice(device) ?: run {
                lastError = "Не удалось открыть USB подключение к FTDI"
                return@withContext false
            }

            val prober = try {
                UsbSerialProber.getDefaultProber().probeDevice(device)
            } catch (t: Throwable) {
                null
            }
            val driver = prober ?: FtdiSerialDriver(device)
            if (driver.ports.isEmpty()) {
                lastError = "COM порт не обнаружен в драйвере FTDI"
                return@withContext false
            }

            val p = driver.ports[0]
            port = p
            p.open(connection)

            // Устанавливаем режим UART 8N1 и активные DTR/RTS
            setUartMode(baud)

            // Снижаем FTDI Latency Timer до 2 мс для мгновенного отклика K-Line
            try {
                connection?.controlTransfer(0x40, 0x09, 2, 1, null, 0, 100)
            } catch (t: Throwable) {}

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
     * Установка физического состояния линии TX через аппаратный UART Break:
     * high = true  -> Mark (TX = 5 В, K-Line = 12 В, неактивна/Idle)  -> Break OFF
     * high = false -> Space (TX = 0 В, K-Line = 0 В, активна)        -> Break ON
     */
    fun setPinState(high: Boolean) {
        try {
            port?.setBreak(!high)
        } catch (t: Throwable) {
            lastError = "setBreak error: ${t.message}"
        }
    }

    /**
     * Конфигурация режима UART (8N1) и удержание линий питания K-Line (DTR/RTS)
     */
    fun setUartMode(baud: Int = 9600) {
        try {
            port?.setBreak(false)
            port?.setParameters(baud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            port?.setDTR(true)
            port?.setRTS(true)
        } catch (t: Throwable) {
            lastError = "setUartMode error: ${t.message}"
        }
    }

    /**
     * Посылка 5-бодовой последовательности инициализации адреса ЭБУ
     * по абсолютному дедлайну согласно спецификации KWP1281 (2000.0 мс на посылку).
     */
    suspend fun send5BaudInitAddress(
        address: Int = 0x01,
        targetBaud: Int = 9600,
        onLog: (String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val p = port ?: run {
            lastError = "Порт не открыт"
            return@withContext false
        }
        onLog("Инициализация K-Line (DTR/RTS активны, пауза 250 мс)...")

        try {
            // 1. Убеждаемся, что режим UART установлен и линия в состоянии Idle (HIGH, 12 В)
            setUartMode(targetBaud)
            setPinState(true)

            // 2. Пауза перед стартом: ~250 мс
            Thread.sleep(250)

            onLog("5 бод: посылка адреса 0x%02X (200.0 мс/бит, 7O1)...".format(address))

            val tStart = System.nanoTime()

            fun waitExactDeadline(stepIndex: Int) {
                val deadline = tStart + (stepIndex * BIT_DURATION_NANOS)
                while (System.nanoTime() < deadline) {
                    val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
                    if (remainingMs > 12) {
                        try {
                            Thread.sleep(remainingMs - 6)
                        } catch (e: InterruptedException) {}
                    }
                }
            }

            // Шаг 1. Старт-бит: TX = LOW (0 В на K-Line), 200 мс
            setPinState(false)
            waitExactDeadline(1)

            // Шаги 2..8. 7 бит адреса, LSB first, по 200 мс каждый
            var parity = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                parity = parity xor bit
                setPinState(bit == 1)
                waitExactDeadline(2 + i)
            }

            // Шаг 9. Бит чётности: TX = !(parity) -> нечётная чётность (odd), 200 мс
            val parityBit = if (parity != 0) 0 else 1
            setPinState(parityBit == 1)
            waitExactDeadline(9)

            // Шаг 10. Стоп-бит: TX = HIGH (12 В на K-Line), ровно 200 мс
            setPinState(true)
            waitExactDeadline(10)

            // Шаг 11. Дополнительная пауза после стопа: 25 мс
            Thread.sleep(25)

            // Шаг 12. Переключение UART на приём ответа от ЭБУ (8N1)
            setUartMode(targetBaud)

            // Очищаем приёмную очередь и аппаратные буферы от следов break-сигнала
            synchronized(rxQueue) {
                rxQueue.clear()
            }
            try {
                p.purgeHwBuffers(true, true)
            } catch (t: Throwable) {}

            onLog("5-бодовая посылка завершена (2000 мс). Ожидание ответа на $targetBaud бод 8N1...")
            true
        } catch (t: Throwable) {
            lastError = "${t.javaClass.simpleName}: ${t.message}"
            onLog("Ошибка 5-бодовой посылки: ${t.message ?: t.javaClass.simpleName}")
            false
        }
    }

    private fun unreadByte(b: Int) {
        synchronized(rxQueue) {
            rxQueue.addFirst((b and 0xFF).toByte())
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

        while (true) {
            val remaining = (timeoutMs - (System.currentTimeMillis() - start)).toInt()
            if (remaining <= 0) break
            val slice = remaining.coerceIn(5, 30)

            try {
                val readLen = p.read(tempBuf, slice)
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

            while (true) {
                val remaining = (timeoutMs - (System.currentTimeMillis() - start)).toInt()
                if (remaining <= 0) break

                val rx = readByte(remaining)
                if (rx < 0) break

                // 1. Проверяем, не является ли байт нашим собственным эхо на K-Line
                if (!gotEcho && rx == sentVal) {
                    gotEcho = true
                    continue // Эхо принято и отброшено, ждем инверсный ответ ЭБУ
                }

                // 2. Проверяем, является ли байт побитовой инверсией (~byte)
                if (rx == compExpected) {
                    delay(3) // Межбайтная пауза ~3 мс по спецификации KWP1281
                    return@withContext true
                }

                // Повторное эхо пропускаем
                if (rx == sentVal) {
                    continue
                }
            }
            delay(5)
        }
        return@withContext false
    }

    /**
     * Отправка завершающего байта блока 0x03 (не подтверждается инверсией).
     * Аккуратно поглощает только собственное эхо 0x03; если прочитан другой байт (уже ответ ЭБУ),
     * возвращает его в начало очереди rxQueue.
     */
    suspend fun sendEndMarker(timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        try {
            p.write(byteArrayOf(0x03), timeoutMs)
            val rx = readByte(35)
            if (rx >= 0 && rx != 0x03) {
                unreadByte(rx)
            }
            delay(6) // Межблочная пауза ~5–8 мс по спецификации KWP1281
        } catch (t: Throwable) {}
    }

    /**
     * Отправка байта без подтверждения (для инверсии ~KW2 или подтверждения входящего байта).
     * Поглощает только собственное эхо sentVal; любой иной байт возвращается в очередь.
     */
    suspend fun writeRawByte(b: Byte, timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        val sentVal = b.toInt() and 0xFF
        try {
            p.write(byteArrayOf(b), timeoutMs)
            val rx = readByte(35)
            if (rx >= 0 && rx != sentVal) {
                unreadByte(rx)
            }
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
            port?.setBreak(false)
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
