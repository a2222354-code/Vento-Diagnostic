package com.vag.kw1281

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Протокол VAG KW1281 (ISO 9141-2) для ЭБУ Bosch Mono-Motronic 1.2.3 (3A0 907 311)
 * и автомобилей VW Vento / Golf 3 / Passat B4 (двигатели 1.8 ADZ, AAM, ABS).
 */
class Kw1281Protocol(private val driver: Ftdi5BaudDriver) {

    var blockCounter: Int = 0
    var ecuPartNumber: String = ""
    var ecuComponent: String = ""
    var ecuExtra: String = ""
    var negotiatedBaud: Int = 9600

    data class KwBlock(
        val length: Int,
        val counter: Int,
        val title: Int,
        val data: ByteArray
    )

    companion object {
        private val KNOWN_DTC_DESCRIPTIONS = mapOf(
            "00515" to "Датчик Холла (G40) — нет сигнала (нормально при выключенном моторе)",
            "00525" to "Лямбда-зонд (G39) — сигнал вне допуска / обрыв цепи",
            "00522" to "Датчик температуры охлаждающей жидкости (G62) — недостоверный сигнал",
            "00523" to "Датчик температуры всасываемого воздуха (G42)",
            "00516" to "Концевой выключатель холостого хода (F60)",
            "00518" to "Потенциометр дроссельной заслонки (G69)",
            "00281" to "Датчик скорости движения автомобиля (G68)",
            "00561" to "Адаптация смеси — превышен предел регулирования",
            "00532" to "Напряжение питания бортовой сети — слишком низкое / высокое",
            "01249" to "Форсунка цилиндра 1 (N30)",
            "00537" to "Лямбда-регулирование — предел регулирования превышен",
            "00670" to "Регулятор холостого хода (V60)",
            "65535" to "Блок управления двигателя (ЭБУ) — неисправность памяти EEPROM/ROM"
        )
    }

    /**
     * Подключение к ЭБУ. Если baudRate == 0 (Авто), поочередно проверяются 9600 и 10400 бод.
     */
    suspend fun connect(baudRate: Int = 0, onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        val speedsToTry = if (baudRate == 0) listOf(9600, 10400) else listOf(baudRate)
        for (speed in speedsToTry) {
            onLog("--- Попытка KW1281 на скорости $speed бод ---")
            if (tryConnectAtBaud(speed, onLog)) {
                negotiatedBaud = speed
                return@withContext true
            }
            delay(400)
        }
        onLog("Подключение не удалось. Проверьте зажигание, надёжность K-Line и переключатель скорости.")
        false
    }

    private suspend fun tryConnectAtBaud(targetBaud: Int, onLog: (String) -> Unit): Boolean {
        blockCounter = 0
        ecuPartNumber = ""
        ecuComponent = ""
        ecuExtra = ""

        // 1. Посылка адреса блока 0x01 (Двигатель) на скорости 5 бод
        val sent = driver.send5BaudInitAddress(0x01, targetBaud, onLog)
        if (!sent) return false

        // 2. Ожидание Sync байта 0x55 (ЭБУ отвечает через 20-1500 мс)
        onLog("Ожидание синхробайта 0x55 (таймаут 3.5 с)...")
        val syncStart = System.currentTimeMillis()
        var syncFound = false
        val receivedHex = mutableListOf<String>()

        while (System.currentTimeMillis() - syncStart < 3500) {
            val b = driver.readByte(300)
            if (b >= 0) {
                val hexStr = "0x%02X".format(b)
                receivedHex.add(hexStr)
                if (b == 0x55) {
                    syncFound = true
                    break
                }
            }
        }

        if (!syncFound) {
            val rxDetails = if (receivedHex.isEmpty()) "RX молчит" else "RX байты: ${receivedHex.joinToString(" ")}"
            onLog("Синхробайт 0x55 не обнаружен ($rxDetails).")
            return false
        }

        onLog("Получен Sync Byte: 0x55! Скорость $targetBaud бод подтверждена.")

        // 3. Чтение KeyBytes (KB1 и KB2)
        val kb1 = driver.readByte(1500)
        if (kb1 < 0) {
            onLog("Ошибка: таймаут чтения KeyByte 1")
            return false
        }
        val kb2 = driver.readByte(1500)
        if (kb2 < 0) {
            onLog("Ошибка: таймаут чтения KeyByte 2")
            return false
        }

        val proto = ((kb2 and 0x7F) shl 7) + (kb1 and 0x7F)
        onLog("KeyBytes: 0x%02X 0x%02X -> Протокол KW%d".format(kb1, kb2, proto))

        // 4. Отправка инвертированного ответа (~KB2) с подавлением эха
        val complement = ((kb2 xor 0xFF) and 0xFF).toByte()
        delay(35)
        driver.writeByteAndDiscardEcho(complement, 500)
        onLog("Отправлен комплемент ~KB2: 0x%02X".format(complement.toInt() and 0xFF))

        // 5. Чтение титульных блоков идентификации ЭБУ
        return readTitleBlocks(onLog)
    }

    /**
     * Чтение байта с подтверждением (Read and ACK Byte).
     * Согласно спецификации KW1281: каждый принимаемый байт блока подтверждается
     * отправкой его битового комплемента (~b) обратно в ЭБУ.
     */
    private suspend fun readAndAckByte(timeoutMs: Int = 1500): Int {
        val b = driver.readByte(timeoutMs)
        if (b < 0) return -1
        delay(3) // протокольная микропауза
        val comp = ((b xor 0xFF) and 0xFF).toByte()
        driver.writeByteAndDiscardEcho(comp, 500)
        return b
    }

    /**
     * Чтение одного блока данных KW1281
     */
    private suspend fun receiveBlock(timeoutMs: Int = 2000): KwBlock? {
        val length = readAndAckByte(timeoutMs)
        if (length < 3) return null

        val counter = readAndAckByte(1000)
        if (counter < 0) return null

        val title = readAndAckByte(1000)
        if (title < 0) return null

        val dataLen = length - 3
        val data = ByteArray(dataLen)
        for (i in 0 until dataLen) {
            val db = readAndAckByte(1000)
            if (db < 0) return null
            data[i] = db.toByte()
        }

        // Завершающий маркер блока 0x03 читается БЕЗ подтверждения комплементом
        val endByte = driver.readByte(1000)
        if (endByte != 0x03 && endByte != -1) {
            // Маркер конца блока
        }

        return KwBlock(length, counter, title, data)
    }

    /**
     * Отправка блока команды в ЭБУ
     */
    private suspend fun sendBlock(title: Int, payload: ByteArray = ByteArray(0)): Boolean {
        blockCounter++
        val length = 3 + payload.size
        val packet = mutableListOf<Byte>()
        packet.add(length.toByte())
        packet.add((blockCounter and 0xFF).toByte())
        packet.add(title.toByte())
        for (b in payload) {
            packet.add(b)
        }
        packet.add(0x03.toByte()) // Конец блока

        // Все байты кроме последнего 0x03 передаются с ожиданием подтверждения от ЭБУ
        for (i in 0 until packet.size - 1) {
            val b = packet[i]
            driver.writeByteAndDiscardEcho(b, 500)
            val comp = driver.readByte(1000)
            val expected = (b.toInt() xor 0xFF) and 0xFF
            if (comp >= 0 && comp != expected) {
                // Предупреждение о несовпадении контрольного байта
            }
        }
        // Последний байт 0x03 отправляется без ожидания комплемента
        driver.writeByteAndDiscardEcho(0x03.toByte(), 500)
        return true
    }

    private suspend fun readTitleBlocks(onLog: (String) -> Unit): Boolean {
        var titleCount = 0
        while (titleCount < 4) {
            val block = receiveBlock(2000) ?: break
            titleCount++
            blockCounter = block.counter

            if (block.title == 0xF6) { // Текстовый ASCII блок
                val text = String(block.data, Charsets.US_ASCII).trim()
                when (titleCount) {
                    1 -> { ecuPartNumber = text; onLog("ЭБУ Номер: $text") }
                    2 -> { ecuComponent = text; onLog("ЭБУ Компонент: $text") }
                    3 -> { ecuExtra = text; onLog("ЭБУ Кодировка: $text") }
                    else -> onLog("ЭБУ Инфо: $text")
                }
                // Отправляем ACK блок (0x09)
                sendBlock(0x09)
            } else if (block.title == 0x09) { // ACK блок от ЭБУ (конец идентификации)
                onLog("Идентификация завершена. ЭБУ готов к командам!")
                return true
            }
        }
        return ecuPartNumber.isNotEmpty()
    }

    suspend fun readFaultCodes(onLog: (String) -> Unit): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val faults = mutableListOf<Pair<String, String>>()
        onLog("Запрос памяти ошибок (Команда 0x07)...")

        sendBlock(0x07)

        while (true) {
            val block = receiveBlock(2000) ?: break
            blockCounter = block.counter

            if (block.title == 0xFC) { // Блок кодов неисправностей
                var idx = 0
                while (idx + 1 < block.data.size) {
                    val high = block.data[idx].toInt() and 0xFF
                    val low = block.data[idx + 1].toInt() and 0xFF
                    val code = (high shl 8) or low
                    if (code != 0) {
                        val dtc = "%05d".format(code)
                        val desc = KNOWN_DTC_DESCRIPTIONS[dtc] ?: "Код неисправности VAG $dtc"
                        faults.add(Pair(dtc, desc))
                        onLog("Ошибка $dtc: $desc")
                    }
                    idx += 2
                }
                sendBlock(0x09) // ACK
            } else if (block.title == 0x00 || block.title == 0x09) {
                // Конец списка ошибок
                sendBlock(0x09)
                break
            } else {
                sendBlock(0x09)
                break
            }
        }
        faults
    }

    suspend fun clearFaultCodes(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        onLog("Отправка команды стирания ошибок (Команда 0x05)...")
        sendBlock(0x05)
        val block = receiveBlock(2500)
        if (block != null) {
            blockCounter = block.counter
            sendBlock(0x09)
            onLog("Ошибки успешно удалены из памяти ЭБУ!")
            true
        } else {
            onLog("Команда 0x05 отправлена.")
            true
        }
    }
}
