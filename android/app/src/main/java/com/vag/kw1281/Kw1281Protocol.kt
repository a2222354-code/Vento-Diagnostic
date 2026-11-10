package com.vag.kw1281

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/**
 * Протокол VAG KW1281 для ЭБУ Bosch Mono-Motronic 1.2.3 (3A0 907 311)
 */
class Kw1281Protocol(private val driver: Ftdi5BaudDriver) {

    var blockCounter: Int = 0
    var ecuPartNumber: String = ""
    var ecuComponent: String = ""
    var ecuExtra: String = ""

    suspend fun connect(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        onLog("Запуск сессии KW1281 для ЭБУ Двигателя...")
        
        // 1. Посылка 5 бод
        val sent = driver.send5BaudInitAddress(0x01, onLog)
        if (!sent) return@withContext false

        // 2. Ожидание Sync байта 0x55
        val buf = ByteArray(16)
        val readSync = driver.readBytes(buf, 2500)
        if (readSync <= 0 || buf[0] != 0x55.toByte()) {
            onLog("Синхробайт 0x55 не получен. Проверьте зажигание и подключение K-Line.")
            return@withContext false
        }
        onLog("Получен Sync Byte: 0x55! Скорость связи синхронизирована: 9600 бод.")

        // 3. Чтение KeyBytes
        val readKb = driver.readBytes(buf, 1000)
        if (readKb < 2) {
            onLog("Не удалось прочитать KeyBytes")
            return@withContext false
        }
        val kb1 = buf[0].toInt() and 0xFF
        val kb2 = buf[1].toInt() and 0xFF
        onLog("KeyByte1 = 0x%02X, KeyByte2 = 0x%02X (Протокол KW1281)".format(kb1, kb2))

        // 4. Отправка инвертированного KB2 (~KB2)
        val complement = (kb2 xor 0xFF).toByte()
        delay(100)
        driver.writeBytes(byteArrayOf(complement), 500)
        onLog("Отправлен инвертированный ответ: 0x%02X".format(complement.toInt() and 0xFF))

        // 5. Чтение титульных блоков ЭБУ
        readTitleBlocks(onLog)
        true
    }

    private suspend fun readTitleBlocks(onLog: (String) -> Unit) {
        val rx = ByteArray(128)
        repeat(3) { i ->
            val len = driver.readBytes(rx, 1500)
            if (len > 3) {
                val text = String(rx, 2, len - 3, Charsets.US_ASCII).trim()
                when (i) {
                    0 -> { ecuPartNumber = text; onLog("ЭБУ Номер: $text") }
                    1 -> { ecuComponent = text; onLog("ЭБУ Версия: $text") }
                    2 -> { ecuExtra = text; onLog("ЭБУ Кодировка: $text") }
                }
                sendAckBlock()
            }
        }
    }

    private suspend fun sendAckBlock() {
        blockCounter++
        val ack = byteArrayOf(0x03, (blockCounter and 0xFF).toByte(), 0x09, 0x03)
        driver.writeBytes(ack, 500)
    }

    suspend fun readFaultCodes(onLog: (String) -> Unit): List<String> = withContext(Dispatchers.IO) {
        blockCounter++
        val req = byteArrayOf(0x03, (blockCounter and 0xFF).toByte(), 0x07, 0x03)
        driver.writeBytes(req, 500)
        onLog("Запрос кодов ошибок (Команда 0x07)...")
        
        val faults = mutableListOf<String>()
        val buf = ByteArray(64)
        val len = driver.readBytes(buf, 2000)
        if (len >= 6) {
            val high = buf[3].toInt() and 0xFF
            val low = buf[4].toInt() and 0xFF
            val code = (high shl 8) or low
            val dtcStr = "%05d".format(code)
            faults.add(dtcStr)
            onLog("Обнаружена ошибка: $dtcStr")
        }
        faults
    }

    suspend fun clearFaultCodes(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        blockCounter++
        val req = byteArrayOf(0x03, (blockCounter and 0xFF).toByte(), 0x05, 0x03)
        driver.writeBytes(req, 500)
        onLog("Отправка команды стирания ошибок 0x05...")
        true
    }
}
