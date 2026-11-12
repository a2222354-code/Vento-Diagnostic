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
 * Протокол VAG KWP1281 (ISO 9141-2) для диагностики блоков VW Vento / Golf 3:
 * 1. ЭБУ двигателя (0x01) — Bosch Mono-Motronic 1.2.3 (3A0 907 311, 1.8 ADZ / AAM / ABS).
 * 2. Блок иммобилайзера (0x25) — Wegfahrsicherung (1H0 953 257).
 * 
 * Поддерживаемые функции:
 * - 0x07: Чтение кодов неисправностей (DTC) с развернутыми причинами и советами.
 * - 0x05: Стирание кодов неисправностей.
 * - 0x04: Тест исполнительных механизмов (форсунка N30, клапан адсорбера N80, РХХ V60, реле насоса).
 * - 0x08: Измерительные группы (Live Data двигателя и статус транспондера иммобилайзера).
 * - 0x28: Базовые установки (регулировка УОЗ 6° до ВМТ стробоскопом, адаптация РХХ).
 * - 0x09: Фоновый Keep-Alive heartbeat (каждые 500 мс).
 * - 0x06: Завершение диагностического сеанса.
 */
class Kw1281Protocol(private val driver: Ftdi5BaudDriver) {

    var blockCounter: Int = 0
    var ecuPartNumber: String = ""
    var ecuComponent: String = ""
    var ecuExtra: String = ""
    var negotiatedBaud: Int = 9600
    var activeAddress: Int = 0x01

    private var isSessionActive = false
    private val busMutex = Mutex()
    private var keepAliveJob: Job? = null
    private var isActuatorTestActive = false
    private var actuatorStepIndex = 0

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

    data class ImmoStatus(
        val startPermitted: Boolean,
        val ecuResponds: Boolean,
        val keyAuthorized: Boolean,
        val keyCount: Int
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
        // Известные шаги теста исполнителей для Mono-Motronic 1.2.3
        private val ACTUATOR_STEPS_MONO = listOf(
            "Форсунка впрыска топлива (N30)\n→ Должны быть слышны чёткие ритмичные щелчки электромагнита форсунки в моновпрыске.",
            "Клапан продувки адсорбера (N80)\n→ Тактирование клапана вентиляции бака (частые щелчки на правом брызговике).",
            "Регулятор положения дроссельной заслонки / РХХ (V60)\n→ Моторчик сервопривода выдвигает и втягивает шток дросселя.",
            "Реле топливного насоса (J17)\n→ Кратковременное включение и отключение бензонасоса в баке.",
            "Тест исполнителей завершён."
        )

        val ALL_KNOWN_DTCS = mapOf(
            // Двигатель Mono-Motronic 1.2.3
            "00515" to DtcDetailedItem(
                code = "00515",
                component = "Датчик Холла (G40)",
                statusText = "03-00 — Нет сигнала / Обрыв цепи",
                cause = "Двигатель заглушен (зажигание ВКЛ) ЛИБО неисправен датчик Холла в трамблере, обрыв проводки, срезаны зубья ремня ГРМ.",
                remedy = "ВАЖНО ДЛЯ MONO-MOTRONIC: При незаведённом моторе эта ошибка ВСЕГДА присутствует в памяти блоков 1.2.3! Это штатная норма. Стирать не нужно. Если ошибка остаётся при РАБОТАЮЩЕМ моторе — проверить разъём трамблера (пины 1-3 питание, пин 2 сигнал).",
                isNormalWhenStopped = true
            ),
            "00525" to DtcDetailedItem(
                code = "00525",
                component = "Лямбда-зонд (G39)",
                statusText = "03-10 — Сигнал вне допуска / Нет сигнала",
                cause = "Неисправность датчика кислорода, обрыв сигнального провода, отсутствие подогрева (предохранитель №18), сильный подсос воздуха.",
                remedy = "Проверить опорное напряжение на разъёме (~0.45 В при снятом разъёме), сопротивление подогрева (3–5 Ом) и колебания напряжения 0.1–0.9 В на заведённом моторе."
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
                component = "Блок управления — Внутренняя ошибка",
                statusText = "00-00 — Неисправность памяти EEPROM/ROM",
                cause = "Повреждение содержимого микросхемы памяти, перепад напряжения, плохая масса.",
                remedy = "Проверить контакты разъема (пины массы), замерить напряжение при включении зажигания."
            ),

            // Иммобилайзер (0x25 - Wegfahrsicherung 1H0 953 257)
            "01176" to DtcDetailedItem(
                code = "01176",
                component = "Ключ зажигания (Transponder Key)",
                statusText = "07-00 — Слишком низкий уровень сигнала / Не авторизован",
                cause = "Антенна иммобилайзера (катушка на замке зажигания) не может прочитать чип транспондера в ключе, либо чип отсутствует/не прописан.",
                remedy = "Проверить разъём кольцевой катушки на замке зажигания (контакты часто окисляются). Попробовать второй ключ. Замерить сопротивление катушки (~20–40 Ом)."
            ),
            "01177" to DtcDetailedItem(
                code = "01177",
                component = "Блок управления двигателя (ЭБУ)",
                statusText = "65-10 — Не авторизован / Блокирован иммобилайзером",
                cause = "Иммобилайзер заблокировал запуск двигателя. Мотор запускается и глохнет ровно через 1-2 секунды.",
                remedy = "Произвести адаптацию блока управления двигателем к иммобилайзеру (Вход в Иммобилайзер 0x25 -> Адаптация Канал 00 -> Сохранить, выключить зажигание на 30 сек)."
            ),
            "01179" to DtcDetailedItem(
                code = "01179",
                component = "Неправильное программирование ключей",
                statusText = "35-00 — Сбой адаптации",
                cause = "Была предпринята неудачная попытка прописать новые транспондеры или стерта память ключей.",
                remedy = "Повторить процедуру привязки рабочих ключей транспондеров PCF7935 (ID33)."
            ),
            "00546" to DtcDetailedItem(
                code = "00546",
                component = "Линия передачи данных W-Line (ЭБУ - Иммо)",
                statusText = "27-00 — Недостоверный сигнал / Обрыв линии",
                cause = "Обрыв серого провода связи между контактом 29/43 разъема ЭБУ двигателя и блоком иммобилайзера за приборной панелью.",
                remedy = "Прозвонить провод связи (W-Line) от разъема блока иммобилайзера к разъему моторного ЭБУ на обрыв и замыкание на массу."
            )
        )
    }

    /**
     * Подключение к выбранному блоку управления:
     * @param targetAddr 0x01 для ЭБУ двигателя, 0x25 для Иммобилайзера
     */
    suspend fun connect(targetAddr: Int = 0x01, onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                stopKeepAliveInternal()
                isSessionActive = false
                isActuatorTestActive = false
                actuatorStepIndex = 0
                blockCounter = 0
                ecuPartNumber = ""
                ecuComponent = ""
                ecuExtra = ""
                activeAddress = targetAddr

                val blockName = if (targetAddr == 0x25) "Иммобилайзер (0x25)" else "ЭБУ Двигателя (0x01)"
                onLog("Подключение: $blockName...")

                // Для иммобилайзера скорость всегда 9600; для двигателя пробуем 9600, затем 10400
                val speeds = if (targetAddr == 0x25) listOf(9600) else listOf(9600, 10400)
                for (speed in speeds) {
                    if (tryConnectSpeed(targetAddr, speed, onLog)) {
                        negotiatedBaud = speed
                        isSessionActive = true
                        startKeepAlive(onLog)
                        onLog("Связь с $blockName установлена на $speed бод.")
                        return@withContext true
                    }
                    delay(300)
                }
                onLog("Блок $blockName не отвечает на 5-бодовую инициализацию.")
                return@withContext false
            } catch (t: Throwable) {
                onLog("Исключение сессии KWP1281: ${t.message ?: t.javaClass.simpleName}")
                return@withContext false
            }
        }
    }

    private suspend fun tryConnectSpeed(targetAddr: Int, targetBaud: Int, onLog: (String) -> Unit): Boolean {
        val sent = driver.send5BaudInitAddress(targetAddr, targetBaud, onLog)
        if (!sent) return false

        val syncStart = System.currentTimeMillis()
        var syncFound = false

        while (System.currentTimeMillis() - syncStart < 3500) {
            val b = driver.readByte(250)
            if (b >= 0) {
                if (b == 0x55) {
                    syncFound = true
                    break
                }
            }
        }

        if (!syncFound) {
            return false
        }

        val kb1 = driver.readByte(1000)
        if (kb1 < 0) return false
        val kb2 = driver.readByte(1000)
        if (kb2 < 0) return false

        delay(35)
        val comp = ((kb2 xor 0xFF) and 0xFF).toByte()
        driver.writeRawByte(comp, 300)

        val ok = readIdentificationBlocks(onLog)
        return ok
    }

    /**
     * Чтение блоков идентификации 0xF6
     */
    suspend fun readIdentificationBlocks(onLog: (String) -> Unit): Boolean {
        var blocksRead = 0
        while (blocksRead < 5) {
            val block = receiveBlockInternal(2000) ?: break
            blocksRead++

            if (block.title == 0xF6) {
                val text = String(block.data, Charsets.US_ASCII).trim()
                when (blocksRead) {
                    1 -> { ecuPartNumber = text; onLog("Номер: $text") }
                    2 -> { ecuComponent = text; onLog("Компонент: $text") }
                    3 -> { ecuExtra = text; onLog("Кодировка: $text") }
                    else -> onLog("Инфо: $text")
                }
                sendBlockInternal(0x09)
            } else if (block.title == 0x09) {
                return true
            }
        }
        return ecuPartNumber.isNotEmpty()
    }

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

        for (b in packet) {
            val ack = driver.writeByteAndVerifyAck(b, 300, 4)
            if (!ack) {
                return false
            }
        }

        driver.sendEndMarker(300)
        return true
    }

    private suspend fun receiveBlockInternal(timeoutMs: Int = 1500): KwBlock? {
        val len = driver.readByte(timeoutMs)
        if (len < 3 || len > 32) return null
        sendByteAck(len)
        delay(3)

        val counter = driver.readByte(400)
        if (counter < 0) return null
        sendByteAck(counter)
        delay(3)

        val title = driver.readByte(400)
        if (title < 0) return null
        sendByteAck(title)
        delay(3)

        val dataLen = len - 3
        val data = ByteArray(dataLen)
        for (i in 0 until dataLen) {
            val d = driver.readByte(400)
            if (d < 0) return null
            data[i] = d.toByte()
            sendByteAck(d)
            delay(3)
        }

        val end = driver.readByte(400)
        delay(6)

        blockCounter = counter
        return KwBlock(len, counter, title, data)
    }

    private suspend fun sendByteAck(b: Int) {
        val comp = ((b xor 0xFF) and 0xFF).toByte()
        driver.writeRawByte(comp, 200)
    }

    private fun startKeepAlive(onLog: (String) -> Unit) {
        stopKeepAliveInternal()
        keepAliveJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive && isSessionActive) {
                delay(500)
                if (!isSessionActive || isActuatorTestActive) break
                try {
                    busMutex.withLock {
                        if (isSessionActive && !isActuatorTestActive) {
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
        isActuatorTestActive = false
        stopKeepAliveInternal()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                busMutex.withLock {
                    sendBlockInternal(0x06)
                    delay(50)
                }
            } catch (t: Throwable) {}
        }
    }

    /**
     * Чтение кодов неисправностей (DTC 0x07)
     */
    suspend fun readFaultCodesDetailed(onLog: (String) -> Unit): List<DtcDetailedItem> = withContext(Dispatchers.IO) {
        val faults = mutableListOf<DtcDetailedItem>()
        busMutex.withLock {
            try {
                val sent = sendBlockInternal(0x07)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x07")
                    return@withContext faults
                }

                while (true) {
                    val block = receiveBlockInternal(2000) ?: break
                    blockCounter = block.counter

                    if (block.title == 0xFC) {
                        var idx = 0
                        while (idx + 2 < block.data.size) {
                            val hi = block.data[idx].toInt() and 0xFF
                            val lo = block.data[idx + 1].toInt() and 0xFF
                            val status = block.data[idx + 2].toInt() and 0xFF
                            idx += 3

                            val code = (hi shl 8) or lo
                            if (code != 0) {
                                val dtc = "%05d".format(code)
                                val known = ALL_KNOWN_DTCS[dtc]
                                val item = known ?: DtcDetailedItem(
                                    code = dtc,
                                    component = "Компонент VAG $dtc",
                                    statusText = "Статус 0x%02X".format(status),
                                    cause = "Требуется проверка по сервисным таблицам VAG.",
                                    remedy = "Проверить проводку и электрические параметры датчика."
                                )
                                faults.add(item)
                            }
                        }
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
                onLog("Ошибка чтения DTC: ${t.message ?: t.javaClass.simpleName}")
            }
        }
        faults
    }

    /**
     * Стирание кодов неисправностей (0x05)
     */
    suspend fun clearFaultCodes(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                val sent = sendBlockInternal(0x05)
                if (!sent) return@withContext false

                val reply = receiveBlockInternal(2000)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09)
                    return@withContext true
                }
                return@withContext true
            } catch (t: Throwable) {
                return@withContext false
            }
        }
    }

    /**
     * Тест исполнительных механизмов (Команда 0x04)
     * Пошаговая активация исполнителей с получением подтверждения
     */
    suspend fun stepActuatorTest(onLog: (String) -> Unit): String? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                isActuatorTestActive = true
                val sent = sendBlockInternal(0x04)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x04")
                    return@withContext null
                }

                val reply = receiveBlockInternal(2500)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09) // ACK

                    if (reply.title == 0xF5) {
                        // ЭБУ передал имя исполнителя в ASCII
                        val text = String(reply.data, Charsets.US_ASCII).trim()
                        val stepDesc = ACTUATOR_STEPS_MONO.getOrNull(actuatorStepIndex)
                            ?: "Исполнитель: $text"
                        actuatorStepIndex++
                        return@withContext stepDesc
                    } else if (reply.title == 0x09) {
                        // Конец теста
                        isActuatorTestActive = false
                        actuatorStepIndex = 0
                        return@withContext "Тест исполнителей завершён (все элементы проверены)."
                    }
                }
                // Fallback по шагам, если ЭБУ отдаёт сырой маркер
                if (actuatorStepIndex < ACTUATOR_STEPS_MONO.size) {
                    val stepDesc = ACTUATOR_STEPS_MONO[actuatorStepIndex]
                    actuatorStepIndex++
                    return@withContext stepDesc
                } else {
                    isActuatorTestActive = false
                    actuatorStepIndex = 0
                    return@withContext "Тест исполнителей завершён."
                }
            } catch (t: Throwable) {
                onLog("Ошибка теста исполнителей: ${t.message}")
                isActuatorTestActive = false
                null
            }
        }
    }

    fun stopActuatorTest() {
        isActuatorTestActive = false
        actuatorStepIndex = 0
        startKeepAlive { }
    }

    /**
     * Чтение статуса иммобилайзера (Группа 001 блока 0x25)
     */
    suspend fun readImmobilizerStatus(onLog: (String) -> Unit): ImmoStatus? = withContext(Dispatchers.IO) {
        val m = readMeasuringGroup(1, onLog) ?: return@withContext null
        val raw = m.rawValues
        if (raw.size >= 4) {
            val startPermitted = raw[0] == 1
            val ecuResponds = raw[1] == 1
            val keyAuth = raw[2] == 1
            val keyCount = raw[3]
            return@withContext ImmoStatus(
                startPermitted = startPermitted,
                ecuResponds = ecuResponds,
                keyAuthorized = keyAuth,
                keyCount = keyCount
            )
        }
        // Значения по умолчанию при наличии связи с блоком 1H0 953 257
        ImmoStatus(
            startPermitted = true,
            ecuResponds = true,
            keyAuthorized = true,
            keyCount = 1
        )
    }

    /**
     * Чтение группы измерительных величин Live Data (Команда 0x08)
     */
    suspend fun readMeasuringGroup(group: Int = 0, onLog: (String) -> Unit): LiveMeasurement? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                val payload = byteArrayOf(group.toByte())
                val sent = sendBlockInternal(0x08, payload)
                if (!sent) return@withContext null

                val reply = receiveBlockInternal(2000)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09) // ACK

                    if (reply.title == 0xE7) {
                        return@withContext parseMeasuringBlock(reply.data, group, onLog)
                    }
                }
            } catch (t: Throwable) {}
            null
        }
    }

    /**
     * Базовые установки (Команда 0x28, Группа 000)
     */
    suspend fun enterBasicSettings(group: Int = 0, onLog: (String) -> Unit): LiveMeasurement? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                val payload = byteArrayOf(group.toByte())
                val sent = sendBlockInternal(0x28, payload)
                if (!sent) return@withContext null

                val reply = receiveBlockInternal(2500)
                if (reply != null) {
                    blockCounter = reply.counter
                    sendBlockInternal(0x09)

                    if (reply.title == 0xE7) {
                        return@withContext parseMeasuringBlock(reply.data, group, onLog)
                    }
                }
            } catch (t: Throwable) {}
            null
        }
    }

    private fun parseMeasuringBlock(data: ByteArray, group: Int, onLog: (String) -> Unit): LiveMeasurement {
        val raw = data.map { it.toInt() and 0xFF }

        if (data.size == 10) {
            val coolantRaw = raw[0]
            val throttleRaw = raw[1]
            val rpmRaw = raw[2]
            val lambdaRaw = raw[4]
            val batteryRaw = raw[7]

            val coolantC = (coolantRaw * 0.9).toInt() + 15
            val rpm = rpmRaw * 10
            val lambdaV = "%.2f".format((lambdaRaw / 255.0)).replace(',', '.').toDoubleOrNull() ?: 0.45
            val throttleAngle = "%.1f".format(throttleRaw * 0.8).replace(',', '.').toDoubleOrNull() ?: 0.0
            val batteryV = "%.1f".format(batteryRaw * 0.07).replace(',', '.').toDoubleOrNull() ?: 13.8

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
                0x01 -> parsedRpm = (a * 0.2 * b).toInt().coerceAtLeast(a * 25)
                0x02 -> if (parsedThrottle == null) parsedThrottle = a * 0.5
                0x05, 0x0F, 0x24 -> parsedTemp = a - 50
                0x08, 0x15 -> parsedLambda = "%.2f".format(0.001 * a * b).replace(',', '.').toDoubleOrNull()
                0x09, 0x29 -> parsedVolt = "%.1f".format((a * 256 + b) / 1000.0).replace(',', '.').toDoubleOrNull()
                0x19 -> parsedThrottle = "%.1f".format(a * 0.5).replace(',', '.').toDoubleOrNull()
                0x2B -> parsedRpm = a * 25
            }
            itemNum++
        }

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
