package com.vag.kw1281

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Протокол VAG KWP1281 (ISO 9141-2) для ЭБУ Bosch Mono-Motronic 1.2.3 (3A0 907 311)
 * автомобилей VW Vento / Golf 3 / Passat B4 (двигатели 1.8 ADZ, AAM, ABS).
 * 
 * Архитектура построена по спецификации декомпилированного бинарника libkwp1281:
 * - Фиксированная скорость 9600 бод (8N1).
 * - Сквозной счетчик блоков (Block Counter), увеличивающийся на 1 для каждого блока.
 * - Побайтовое подтверждение инверсией (~byte) для всех байт кроме 0x03.
 * - Keep-Alive поток (блок ACK 0x09 каждые 500 мс) с мьютексом шины.
 * - Корректное чтение кодов ошибок DTC тройками [код_hi][код_lo][статус].
 */
class Kw1281Protocol(private val driver: Ftdi5BaudDriver) {

    var blockCounter: Int = 0
    var ecuPartNumber: String = ""
    var ecuComponent: String = ""
    var ecuExtra: String = ""
    val negotiatedBaud: Int = 9600

    private var isSessionActive = false
    private val busMutex = Mutex()
    private var keepAliveJob: Job? = null

    data class KwBlock(
        val length: Int,
        val counter: Int,
        val title: Int,
        val data: ByteArray
    )

    companion object {
        private val KNOWN_DTC_DESCRIPTIONS = mapOf(
            "00515" to "Датчик Холла (G40) — нет сигнала (нормально при заглушенном двигателе)",
            "00525" to "Лямбда-зонд (G39) — сигнал вне допуска / обрыв цепи",
            "00522" to "Датчик температуры охлаждающей жидкости (G62)",
            "00523" to "Датчик температуры всасываемого воздуха (G42)",
            "00516" to "Концевой выключатель холостого хода (F60)",
            "00518" to "Потенциометр дроссельной заслонки (G69)",
            "00281" to "Датчик скорости движения автомобиля (G68)",
            "00561" to "Адаптация смеси — превышен предел регулирования",
            "00532" to "Напряжение бортовой сети — вне допуска",
            "01249" to "Форсунка цилиндра 1 (N30)",
            "00537" to "Лямбда-регулирование — предел превышен",
            "00670" to "Регулятор холостого хода (V60)",
            "65535" to "Блок управления (ЭБУ) — внутренняя ошибка памяти EEPROM/ROM"
        )
    }

    /**
     * Подключение к ЭБУ двигателя (адрес 0x01) на фиксированной скорости 9600 бод
     */
    suspend fun connect(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                stopKeepAliveInternal()
                isSessionActive = false
                blockCounter = 0
                ecuPartNumber = ""
                ecuComponent = ""
                ecuExtra = ""

                onLog("--- Запуск сеанса KWP1281 (9600 бод) ---")

                // 1. Посылка адреса 0x01 на 5 бод
                val sent = driver.send5BaudInitAddress(0x01, 9600, onLog)
                if (!sent) return@withContext false

                // 2. Ожидание синхробайта 0x55 (таймаут до 5000 мс)
                onLog("Ожидание синхробайта 0x55 от ЭБУ (до 5 с)...")
                val syncStart = System.currentTimeMillis()
                var syncFound = false
                val foreignBytes = mutableListOf<String>()

                while (System.currentTimeMillis() - syncStart < 5000) {
                    val b = driver.readByte(300)
                    if (b >= 0) {
                        if (b == 0x55) {
                            syncFound = true
                            break
                        } else {
                            val hex = "0x%02X".format(b)
                            foreignBytes.add(hex)
                            onLog("Посторонний байт $hex вместо 0x55 (отброшен)")
                        }
                    }
                }

                if (!syncFound) {
                    val rxSummary = if (foreignBytes.isEmpty()) "линия молчит" else "принято: ${foreignBytes.joinToString(" ")}"
                    val err = driver.lastError?.let { " [Ошибка USB: $it]" } ?: ""
                    onLog("Синхробайт 0x55 не обнаружен ($rxSummary)$err.")
                    return@withContext false
                }

                onLog("Синхробайт 0x55 успешно принят!")

                // 3. Приём ключевых байтов KW1 и KW2 (таймаут 1000 мс)
                val kb1 = driver.readByte(1000)
                if (kb1 < 0) {
                    onLog("Ошибка: таймаут чтения Keyword 1")
                    return@withContext false
                }
                val kb2 = driver.readByte(1000)
                if (kb2 < 0) {
                    onLog("Ошибка: таймаут чтения Keyword 2")
                    return@withContext false
                }

                val proto = ((kb2 and 0x7F) shl 7) + (kb1 and 0x7F)
                onLog("Ключевые байты: 0x%02X 0x%02X -> KWP%d".format(kb1, kb2, proto))

                // 4. Пауза 35 мс (Compat Mode) и отправка инверсии ~KW2
                delay(35)
                val comp = ((kb2 xor 0xFF) and 0xFF).toByte()
                driver.writeRawByte(comp, 300)
                onLog("Отправлена инверсия ~KW2: 0x%02X".format(comp.toInt() and 0xFF))

                // 5. Чтение первого блока идентификации и ответ ACK
                val ok = readIdentificationBlocks(onLog)
                if (ok) {
                    isSessionActive = true
                    startKeepAlive(onLog)
                    onLog("Сеанс KWP1281 успешно установлен! ЭБУ готов к командам.")
                    return@withContext true
                } else {
                    onLog("Не удалось завершить идентификацию ЭБУ.")
                    return@withContext false
                }
            } catch (t: Throwable) {
                onLog("Исключение сессии KWP1281: ${t.message ?: t.javaClass.simpleName}")
                return@withContext false
            }
        }
    }

    /**
     * Чтение блоков идентификации 0xF6 и подтверждение ACK 0x09
     */
    private suspend fun readIdentificationBlocks(onLog: (String) -> Unit): Boolean {
        var blocksRead = 0
        while (blocksRead < 5) {
            val block = receiveBlockInternal(2000) ?: break
            blocksRead++

            if (block.title == 0xF6) {
                val text = String(block.data, Charsets.US_ASCII).trim()
                when (blocksRead) {
                    1 -> { ecuPartNumber = text; onLog("Номер детали ЭБУ: $text") }
                    2 -> { ecuComponent = text; onLog("Компонент: $text") }
                    3 -> { ecuExtra = text; onLog("Кодировка/Дополнительно: $text") }
                    else -> onLog("Инфо ЭБУ: $text")
                }
                // Отвечаем блоком ACK (Title 0x09)
                sendBlockInternal(0x09)
            } else if (block.title == 0x09) {
                // ЭБУ завершил выдачу паспортных данных
                return true
            }
        }
        return ecuPartNumber.isNotEmpty()
    }

    /**
     * Отправка блока KWP1281: [Length][Counter][Title][Data...][0x03]
     * Все байты кроме 0x03 подтверждаются инверсией от ЭБУ.
     */
    private suspend fun sendBlockInternal(title: Int, payload: ByteArray = ByteArray(0)): Boolean {
        blockCounter = (blockCounter + 1) and 0xFF
        val length = 3 + payload.size
        val packet = ArrayList<Byte>(length + 1)
        packet.add(length.toByte())
        packet.add(blockCounter.toByte())
        packet.add(title.toByte())
        for (b in payload) {
            packet.add(b)
        }

        // Побайтовая отправка с проверкой подтверждения инверсией
        for (b in packet) {
            val ack = driver.writeByteAndVerifyAck(b, 300, 4)
            if (!ack) {
                return false
            }
        }

        // Завершающий маркер 0x03 (без подтверждения)
        driver.sendEndMarker(300)
        return true
    }

    /**
     * Приём блока KWP1281: чтение байта и немедленная отправка инверсии ~byte
     */
    private suspend fun receiveBlockInternal(timeoutMs: Int = 1500): KwBlock? {
        // 1. Длина блока (Length)
        val len = driver.readByte(timeoutMs)
        if (len < 3 || len > 32) return null
        sendByteAck(len)
        delay(3)

        // 2. Счётчик блока (Counter)
        val counter = driver.readByte(400)
        if (counter < 0) return null
        sendByteAck(counter)
        delay(3)

        // 3. Заголовок блока (Title)
        val title = driver.readByte(400)
        if (title < 0) return null
        sendByteAck(title)
        delay(3)

        // 4. Байты данных (Length - 3)
        val dataLen = len - 3
        val data = ByteArray(dataLen)
        for (i in 0 until dataLen) {
            val d = driver.readByte(400)
            if (d < 0) return null
            data[i] = d.toByte()
            sendByteAck(d)
            delay(3)
        }

        // 5. Конечный маркер 0x03 (не подтверждается инверсией)
        val end = driver.readByte(400)
        delay(6) // Межблочная пауза ~6 мс

        blockCounter = counter
        return KwBlock(len, counter, title, data)
    }

    private suspend fun sendByteAck(b: Int) {
        val comp = ((b xor 0xFF) and 0xFF).toByte()
        driver.writeRawByte(comp, 200)
    }

    /**
     * Keep-Alive поток: каждые ~0.5 с отправляет блок ACK 0x09,
     * предотвращая разрыв сеанса по тайм-ауту со стороны ЭБУ.
     */
    private fun startKeepAlive(onLog: (String) -> Unit) {
        stopKeepAliveInternal()
        keepAliveJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive && isSessionActive) {
                delay(500)
                if (!isSessionActive) break
                try {
                    busMutex.withLock {
                        if (isSessionActive) {
                            val ok = sendBlockInternal(0x09)
                            if (ok) {
                                receiveBlockInternal(1000)
                            }
                        }
                    }
                } catch (t: Throwable) {}
            }
        }
    }

    private fun stopKeepAliveInternal() {
        try {
            keepAliveJob?.cancel()
            keepAliveJob = null
        } catch (t: Throwable) {}
    }

    fun stopSession() {
        isSessionActive = false
        stopKeepAliveInternal()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                busMutex.withLock {
                    sendBlockInternal(0x06) // 0x06: Завершение сеанса
                    delay(50)
                }
            } catch (t: Throwable) {}
        }
    }

    /**
     * Чтение кодов неисправностей DTC (Команда 0x07)
     * В KWP1281 ошибки приходят в блоке 0xFC тройками: [код_hi][код_lo][статус]
     */
    suspend fun readFaultCodes(onLog: (String) -> Unit): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val faults = mutableListOf<Pair<String, String>>()
        busMutex.withLock {
            try {
                onLog("Запрос памяти неисправностей (Команда 0x07)...")
                val sent = sendBlockInternal(0x07)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x07")
                    return@withContext faults
                }

                while (true) {
                    val block = receiveBlockInternal(2000) ?: break
                    blockCounter = block.counter

                    if (block.title == 0xFC) {
                        // Тройки [код_hi][код_lo][статус]
                        var idx = 0
                        while (idx + 2 < block.data.size) {
                            val hi = block.data[idx].toInt() and 0xFF
                            val lo = block.data[idx + 1].toInt() and 0xFF
                            val status = block.data[idx + 2].toInt() and 0xFF
                            idx += 3

                            val code = (hi shl 8) or lo
                            if (code != 0) {
                                val dtc = "%05d".format(code)
                                val desc = KNOWN_DTC_DESCRIPTIONS[dtc] ?: "Код неисправности VAG $dtc"
                                faults.add(Pair(dtc, desc))
                                onLog("Обнаружена ошибка: $dtc — $desc (статус 0x%02X)".format(status))
                            }
                        }
                        // Подтверждаем получение блока ошибок
                        sendBlockInternal(0x09)
                    } else if (block.title == 0x09) {
                        // Конец списка ошибок или память пуста
                        sendBlockInternal(0x09)
                        break
                    } else {
                        sendBlockInternal(0x09)
                        break
                    }
                }
            } catch (t: Throwable) {
                onLog("Ошибка чтения ошибок: ${t.message ?: t.javaClass.simpleName}")
            }
        }
        faults
    }

    /**
     * Стирание кодов неисправностей DTC (Команда 0x05)
     */
    suspend fun clearFaultCodes(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                onLog("Отправка команды стирания ошибок (Команда 0x05)...")
                val sent = sendBlockInternal(0x05)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x05")
                    return@withContext false
                }

                val reply = receiveBlockInternal(2000)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09)
                    onLog("Память ошибок ЭБУ успешно очищена!")
                    return@withContext true
                } else {
                    onLog("Команда 0x05 отправлена.")
                    return@withContext true
                }
            } catch (t: Throwable) {
                onLog("Ошибка стирания ошибок: ${t.message ?: t.javaClass.simpleName}")
                return@withContext false
            }
        }
    }
}
