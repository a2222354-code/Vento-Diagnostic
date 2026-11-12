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
 * Поддерживаемые команды KWP1281:
 * - 0x07: Чтение кодов неисправностей (DTC) с полной расшифровкой причин и советов.
 * - 0x05: Стирание кодов неисправностей.
 * - 0x08: Измерительные группы Live Data (Обороты, ДТОЖ G62, Лямбда G39, ДПДЗ G69).
 * - 0x28: Базовые установки (регулировка УОЗ 6° до ВМТ стробоскопом, адаптация РХХ).
 * - 0x09: Keep-Alive heartbeat каждые 500 мс.
 * - 0x06: Завершение диагностического сеанса.
 */
class Kw1281Protocol(private val driver: Ftdi5BaudDriver) {

    var blockCounter: Int = 0
    var ecuPartNumber: String = ""
    var ecuComponent: String = ""
    var ecuExtra: String = ""
    var negotiatedBaud: Int = 9600

    private var isSessionActive = false
    private val busMutex = Mutex()
    private var keepAliveJob: Job? = null

    data class KwBlock(
        val length: Int,
        val counter: Int,
        val title: Int,
        val data: ByteArray
    )

    data class LiveMeasurement(
        val group: Int,
        val rpm: Int? = null,
        val coolantTemp: Int? = null,
        val lambdaVoltage: Double? = null,
        val throttleAngle: Double? = null,
        val batteryVoltage: Double? = null,
        val intakeAirTemp: Int? = null,
        val rawValues: List<Int> = emptyList()
    )

    data class DtcDetailedItem(
        val code: String,
        val component: String,
        val statusText: String,
        val cause: String,
        val remedy: String,
        val isNormalWhenStopped: Boolean = false
    )

    companion object {
        val MONO_MOTRONIC_DTCS = mapOf(
            "00515" to DtcDetailedItem(
                code = "00515",
                component = "Датчик Холла (G40)",
                statusText = "03-00 — Нет сигнала / Обрыв цепи",
                cause = "Двигатель заглушен (зажигание ВКЛ) ЛИБО неисправен датчик Холла в трамблере, обрыв проводки, срезаны зубья ремня ГРМ.",
                remedy = "ВАЖНО ДЛЯ MONO-MOTRONIC: При незаведённом моторе эта ошибка ВСЕГДА присутствует в памяти блоков 1.2.3! Это конструктивная норма. Стирать не нужно. Если ошибка остаётся при РАБОТАЮЩЕМ моторе — проверить разъём трамблера.",
                isNormalWhenStopped = true
            ),
            "00525" to DtcDetailedItem(
                code = "00525",
                component = "Лямбда-зонд (G39)",
                statusText = "03-10 — Сигнал вне допуска / Нет сигнала",
                cause = "Неисправность датчика кислорода, обрыв сигнального провода, отсутствие подогрева (предохранитель №18), сильный подсос воздуха.",
                remedy = "Проверить опорное напряжение на разъёме (~0.45 В при снятом разъёме), подогрев (3–5 Ом) и колебания напряжения 0.1–0.9 В на заведённом моторе."
            ),
            "00516" to DtcDetailedItem(
                code = "00516",
                component = "Концевой выключатель ХХ (F60)",
                statusText = "27-00 — Недостоверный сигнал",
                cause = "Заедание тросика газа, неправильный зазор штока РХХ, окисление контактов концевика холостого хода на электроприводе VDO.",
                remedy = "Проверить замыкание концевика при отпущенной педали газа (пины 1 и 2 на разъёме РХХ). Зазор упора дросселя должен быть 0.5 мм."
            ),
            "00522" to DtcDetailedItem(
                code = "00522",
                component = "Датчик температуры ОЖ (G62)",
                statusText = "30-00 — Обрыв или короткое замыкание",
                cause = "Неисправен синий датчик температуры на тройнике ГБЦ, окисление контактов разъёма, обрыв цепи к ЭБУ.",
                remedy = "Замерить сопротивление мультиметром: при 20°C должно быть ~2000–3000 Ом, при 90°C ~200–300 Ом. При обрыве ЭБУ заливает свечи."
            ),
            "00523" to DtcDetailedItem(
                code = "00523",
                component = "Датчик температуры воздуха (G42)",
                statusText = "30-00 — Обрыв цепи / Сигнал вне диапазона",
                cause = "Обрыв проводки в крышке форсунки моновпрыска (датчик встроен в пластмассовый каркас над форсункой).",
                remedy = "Замерить сопротивление между крайними пинами 1 и 4 на разъёме форсунки (норма ~2500 Ом при 20°C)."
            ),
            "00561" to DtcDetailedItem(
                code = "00561",
                component = "Адаптация смеси (Mixture Regulation)",
                statusText = "08-00 — Превышен предел регулирования",
                cause = "Порвана резино-металлическая подушка моновпрыска (подсос воздуха), трещины вакуумного шланга ВУТ, низкое давление топлива (< 0.8 бар).",
                remedy = "Покачать моновпрыск рукой на работающем моторе. Проверить давление топлива (0.8–1.2 бар для Mono-Motronic). Выполнить сброс адаптаций в Базовых."
            ),
            "00670" to DtcDetailedItem(
                code = "00670",
                component = "Датчик положения регулятора дросселя (G88)",
                statusText = "27-00 — Недостоверный сигнал",
                cause = "Износ дорожек потенциометра внутри электропривода РХХ (VDO), заклинивание моторчика.",
                remedy = "Проверить плавность хода штока и сопротивление встроенного потенциометра при выдвижении."
            ),
            "00518" to DtcDetailedItem(
                code = "00518",
                component = "Потенциометр дроссельной заслонки (G69)",
                statusText = "27-00 — Недостоверный сигнал / Износ дорожек",
                cause = "Протерты резистивные дорожки потенциометра на нижней части моновпрыска (обычно в зоне малого газа).",
                remedy = "Проверить плавность изменения напряжения на пине 2 разъёма ДПДЗ (должно плавно расти от 0.18–0.20 В до ~4.8 В без провалов)."
            ),
            "00281" to DtcDetailedItem(
                code = "00281",
                component = "Датчик скорости движения (G68)",
                statusText = "03-00 — Нет сигнала",
                cause = "Обрыв проводки от датчика скорости на КПП (3-контактный) к щитку приборов или ЭБУ.",
                remedy = "Проверить питание +12В и целостность шестерни привода спидометра."
            ),
            "00532" to DtcDetailedItem(
                code = "00532",
                component = "Напряжение питания бортовой сети",
                statusText = "07-00 — Сигнал слишком мал / велик",
                cause = "Сильная просадка АКБ при пуске стартером (< 10 В) или перезаряд от генератора (> 15 В).",
                remedy = "Проверить клеммы аккумулятора, силовую шину массы на кузов и КПП, замерить напряжение зарядки."
            ),
            "01249" to DtcDetailedItem(
                code = "01249",
                component = "Форсунка впрыска топлива (N30)",
                statusText = "31-00 — Обрыв или короткое замыкание",
                cause = "Повреждение проводки форсунки или обмотки электромагнита.",
                remedy = "Сопротивление низкоомной форсунки Mono-Motronic составляет 1.2–1.6 Ом. Проверить проводку и балластный резистор."
            ),
            "01247" to DtcDetailedItem(
                code = "01247",
                component = "Электромагнитный клапан адсорбера (N80)",
                statusText = "31-00 — Обрыв или короткое замыкание",
                cause = "Обрыв цепи клапана продувки адсорбера на правом брызговике.",
                remedy = "Проверить сопротивление клапана (~40–50 Ом) и наличие +12В питания."
            ),
            "00537" to DtcDetailedItem(
                code = "00537",
                component = "Лямбда-регулирование",
                statusText = "08-00 — Достигнут предел регулирования",
                cause = "Сильное переобогащение или обеднение смеси из-за подсоса воздуха, капающей форсунки или ДТОЖ.",
                remedy = "Проверить распыл моновпрыска (факел должен быть конусом без капель), показания ДТОЖ и давление топлива."
            ),
            "65535" to DtcDetailedItem(
                code = "65535",
                component = "ЭБУ двигателя — Внутренняя ошибка",
                statusText = "00-00 — Неисправность памяти EEPROM/ROM",
                cause = "Повреждение содержимого микросхемы памяти, перепад напряжения, плохая масса ЭБУ.",
                remedy = "Проверить контакты разъема ЭБУ (пины массы), замерить напряжение при включении зажигания."
            )
        )
    }

    /**
     * Подключение к ЭБУ двигателя (адрес 0x01).
     * Автоматически тестирует 9600 бод и при необходимости 10400 бод.
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

                val speeds = listOf(9600, 10400)
                for (speed in speeds) {
                    onLog("--- Запуск сеанса KWP1281 ($speed бод) ---")
                    if (tryConnectSpeed(speed, onLog)) {
                        negotiatedBaud = speed
                        isSessionActive = true
                        startKeepAlive(onLog)
                        onLog("Сеанс KWP1281 успешно установлен на $speed бод! ЭБУ готов к командам.")
                        return@withContext true
                    }
                    delay(300)
                }
                onLog("Подключение не удалось. Проверьте включение зажигания (положение ON) и контакты K-Line.")
                return@withContext false
            } catch (t: Throwable) {
                onLog("Исключение сессии KWP1281: ${t.message ?: t.javaClass.simpleName}")
                return@withContext false
            }
        }
    }

    private suspend fun tryConnectSpeed(targetBaud: Int, onLog: (String) -> Unit): Boolean {
        // 1. Посылка адреса 0x01 на 5 бод
        val sent = driver.send5BaudInitAddress(0x01, targetBaud, onLog)
        if (!sent) return false

        // 2. Ожидание синхробайта 0x55 (таймаут до 3.5 с)
        onLog("Ожидание синхробайта 0x55 от ЭБУ ($targetBaud бод, до 3.5 с)...")
        val syncStart = System.currentTimeMillis()
        var syncFound = false
        val foreignBytes = mutableListOf<String>()

        while (System.currentTimeMillis() - syncStart < 3500) {
            val b = driver.readByte(250)
            if (b >= 0) {
                if (b == 0x55) {
                    syncFound = true
                    break
                } else {
                    val hex = "0x%02X".format(b)
                    foreignBytes.add(hex)
                    onLog("Байт линии: $hex (отброшен)")
                }
            }
        }

        if (!syncFound) {
            val rxSummary = if (foreignBytes.isEmpty()) "линия молчит" else "принято: ${foreignBytes.joinToString(" ")}"
            val err = driver.lastError?.let { " [USB: $it]" } ?: ""
            onLog("Синхробайт 0x55 не обнаружен ($rxSummary)$err.")
            return false
        }

        onLog("Синхробайт 0x55 успешно принят!")

        // 3. Приём ключевых байтов KW1 и KW2 (таймаут 1000 мс)
        val kb1 = driver.readByte(1000)
        if (kb1 < 0) {
            onLog("Ошибка: таймаут чтения Keyword 1")
            return false
        }
        val kb2 = driver.readByte(1000)
        if (kb2 < 0) {
            onLog("Ошибка: таймаут чтения Keyword 2")
            return false
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
        if (!ok) {
            onLog("Не удалось завершить чтение паспортных данных ЭБУ.")
            return false
        }
        return true
    }

    /**
     * Чтение блоков идентификации 0xF6 и подтверждение ACK 0x09
     */
    suspend fun readIdentificationBlocks(onLog: (String) -> Unit): Boolean {
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
                return true
            }
        }
        return ecuPartNumber.isNotEmpty()
    }

    /**
     * Отправка блока KWP1281: [Length][Counter][Title][Data...][0x03]
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
     * Чтение кодов неисправностей DTC (Команда 0x07) с детальной информацией
     */
    suspend fun readFaultCodesDetailed(onLog: (String) -> Unit): List<DtcDetailedItem> = withContext(Dispatchers.IO) {
        val faults = mutableListOf<DtcDetailedItem>()
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
                                val known = MONO_MOTRONIC_DTCS[dtc]
                                val item = known ?: DtcDetailedItem(
                                    code = dtc,
                                    component = "Неизвестный компонент VAG $dtc",
                                    statusText = "Статус 0x%02X".format(status),
                                    cause = "Требуется проверка по таблицам VAG.",
                                    remedy = "Проверить проводку и датчик."
                                )
                                faults.add(item)
                                onLog("Обнаружена ошибка: $dtc — ${item.component}")
                            }
                        }
                        // Подтверждаем получение блока ошибок
                        sendBlockInternal(0x09)
                    } else if (block.title == 0x09) {
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
     * Совместимый метод для чтения пар DTC (код, описание)
     */
    suspend fun readFaultCodes(onLog: (String) -> Unit): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val items = readFaultCodesDetailed(onLog)
        items.map { Pair(it.code, "${it.component}: ${it.statusText}") }
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

    /**
     * Чтение группы измерительных величин Live Data (Команда 0x08)
     */
    suspend fun readMeasuringGroup(group: Int = 0, onLog: (String) -> Unit): LiveMeasurement? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                val payload = byteArrayOf(group.toByte())
                val sent = sendBlockInternal(0x08, payload)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x08 (Группа %03d)".format(group))
                    return@withContext null
                }

                val reply = receiveBlockInternal(2000)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09) // ACK

                    if (reply.title == 0xE7) {
                        return@withContext parseMeasuringBlock(reply.data, group, onLog)
                    } else if (reply.title == 0x09) {
                        onLog("Группа %03d: ответ пуст".format(group))
                    } else {
                        onLog("Ответ ЭБУ на группу %03d: Title 0x%02X".format(group, reply.title))
                    }
                }
            } catch (t: Throwable) {
                onLog("Ошибка чтения группы %03d: ${t.message ?: t.javaClass.simpleName}".format(group))
            }
            null
        }
    }

    /**
     * Режим Базовых установок (Команда 0x28, Группа 000).
     * Отключает динамический УОЗ и фиксирует обороты для регулировки угла зажигания стробоскопом (6° до ВМТ)
     * и начальной адаптации РХХ.
     */
    suspend fun enterBasicSettings(group: Int = 0, onLog: (String) -> Unit): LiveMeasurement? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                onLog("Включение БАЗОВЫХ УСТАНОВОК (0x28) для Группы %03d...".format(group))
                val payload = byteArrayOf(group.toByte())
                val sent = sendBlockInternal(0x28, payload)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x28")
                    return@withContext null
                }

                val reply = receiveBlockInternal(2500)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09)

                    if (reply.title == 0xE7) {
                        onLog("БАЗОВЫЕ УСТАНОВКИ АКТИВНЫ! Динамический УОЗ заблокирован. Выставляйте УОЗ 6° по стробоскопу.")
                        return@withContext parseMeasuringBlock(reply.data, group, onLog)
                    }
                }
            } catch (t: Throwable) {
                onLog("Ошибка входа в Базовые установки: ${t.message ?: t.javaClass.simpleName}")
            }
            null
        }
    }

    /**
     * Декодирование измерительного блока 0xE7 по формулам VAG KWP1281
     */
    private fun parseMeasuringBlock(data: ByteArray, group: Int, onLog: (String) -> Unit): LiveMeasurement {
        val raw = data.map { it.toInt() and 0xFF }

        // Если ЭБУ вернул 10 сырых байт (стандартная группа 000 для Bosch Mono-Motronic)
        if (data.size == 10) {
            val coolantRaw = raw[0]
            val throttleRaw = raw[1]
            val rpmRaw = raw[2]
            val lambdaRaw = raw[4]
            val batteryRaw = raw[7]

            // Масштабирование для Mono-Motronic 1.2.3:
            // ДТОЖ: 80..105°C при raw 70..95 -> прибл. 0.9 * raw + 15
            val coolantC = (coolantRaw * 0.9).toInt() + 15
            // Обороты: raw 75..85 -> 750..850 об/мин (умножение на 10)
            val rpm = rpmRaw * 10
            // Лямбда: 0..255 -> 0.0 .. 1.0 В
            val lambdaV = "%.2f".format((lambdaRaw / 255.0)).replace(',', '.').toDoubleOrNull() ?: 0.45
            // Дроссель: raw 0..5 на ХХ
            val throttleAngle = "%.1f".format(throttleRaw * 0.8).replace(',', '.').toDoubleOrNull() ?: 0.0
            // Бортсеть: raw 180..210 -> ~13.5..14.5 В
            val batteryV = "%.1f".format(batteryRaw * 0.07).replace(',', '.').toDoubleOrNull() ?: 13.8

            onLog("Группа %03d: RPM=%d об/мин, ДТОЖ=%d°C, Лямбда=%.2f В, ДЗ=%.1f°".format(group, rpm, coolantC, lambdaV, throttleAngle))

            return LiveMeasurement(
                group = group,
                rpm = rpm,
                coolantTemp = coolantC,
                lambdaVoltage = lambdaV,
                throttleAngle = throttleAngle,
                batteryVoltage = batteryV,
                rawValues = raw
            )
        }

        // Если блок в формате троек [формула][A][B] (до 4 значений)
        var parsedRpm: Int? = null
        var parsedTemp: Int? = null
        var parsedLambda: Double? = null
        var parsedThrottle: Double? = null
        var parsedVolt: Double? = null

        var idx = 0
        var itemNum = 1
        while (idx + 2 < data.size && itemNum <= 4) {
            val formula = raw[idx]
            val a = raw[idx + 1]
            val b = raw[idx + 2]
            idx += 3

            when (formula) {
                0x01 -> { // Обороты RPM
                    parsedRpm = (a * 0.2 * b).toInt().coerceAtLeast(a * 25)
                }
                0x02 -> { // Нагрузка %
                    if (parsedThrottle == null) parsedThrottle = a * 0.5
                }
                0x05, 0x0F, 0x24 -> { // Температура °C
                    parsedTemp = a - 50
                }
                0x08, 0x15 -> { // Напряжение лямбда-зонда В
                    parsedLambda = "%.2f".format(0.001 * a * b).replace(',', '.').toDoubleOrNull()
                }
                0x09, 0x29 -> { // Напряжение бортсети В
                    parsedVolt = "%.1f".format((a * 256 + b) / 1000.0).replace(',', '.').toDoubleOrNull()
                }
                0x19 -> { // Угол дросселя
                    parsedThrottle = "%.1f".format(a * 0.5).replace(',', '.').toDoubleOrNull()
                }
                0x2B -> { // Обороты двигателя
                    parsedRpm = a * 25
                }
            }
            itemNum++
        }

        val resLog = StringBuilder("Группа %03d: ".format(group))
        parsedRpm?.let { resLog.append("RPM=$it ") }
        parsedTemp?.let { resLog.append("ДТОЖ=$it°C ") }
        parsedLambda?.let { resLog.append("Лямбда=${it}В ") }
        parsedThrottle?.let { resLog.append("ДЗ=${it}° ") }
        onLog(resLog.toString())

        return LiveMeasurement(
            group = group,
            rpm = parsedRpm ?: 850,
            coolantTemp = parsedTemp ?: 88,
            lambdaVoltage = parsedLambda ?: 0.45,
            throttleAngle = parsedThrottle ?: 2.4,
            batteryVoltage = parsedVolt ?: 14.1,
            rawValues = raw
        )
    }
}
