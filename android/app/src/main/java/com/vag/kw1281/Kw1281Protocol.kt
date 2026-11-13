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
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Протокол VAG KWP1281 (ISO 9141-2) для диагностики блоков VW Vento / Golf 3:
 * 1. ЭБУ двигателя (0x01) — Bosch Mono-Motronic 1.2.3 (3A0 907 311, 1.8 ADZ / AAM / ABS).
 * 2. Блок иммобилайзера (0x25) — Wegfahrsicherung (1H0 953 257).
 *
 * Строго соблюдается полудуплексный обмен (ping-pong) KWP1281:
 * на каждый запрос тестера ЭБУ отвечает ровно одним блоком,
 * и каждый публичный метод под busMutex начинается и заканчивается в очереди тестера.
 */
class Kw1281Protocol(private val driver: Ftdi5BaudDriver) {

    var blockCounter: Int = 0
    var ecuPartNumber: String = ""
    var ecuComponent: String = ""
    var ecuExtra: String = ""
    var negotiatedBaud: Int = 9600
    var activeAddress: Int = 0x01

    @Volatile
    var isSessionActive: Boolean = false
        private set

    private val busMutex = Mutex()
    private var keepAliveJob: Job? = null
    private var consecutiveKeepAliveErrors = 0
    private var preferredGroupReadCmd: Int? = null

    data class KwBlock(
        val length: Int,
        val counter: Int,
        val title: Int,
        val data: ByteArray
    )

    data class MeasuredField(
        val index: Int,
        val valueText: String,
        val formula: Int,
        val a: Int,
        val b: Int,
        val numericValue: Double = 0.0
    )

    data class LiveMeasurement(
        val group: Int,
        val rpm: Int? = null,
        val coolantTemp: Int? = null,
        val lambdaVoltage: Double? = null,
        val lambdaCorrection: Double? = null,
        val throttleAngle: Double? = null,
        val batteryVoltage: Double? = null,
        val intakeAirTemp: Int? = null,
        val injectionTimeMs: Double? = null,
        val rawValues: List<Int> = emptyList(),
        val fields: List<MeasuredField> = emptyList(),
        val isUnsupportedNak: Boolean = false,
        val errorMessage: String? = null
    )

    data class ActuatorStepResult(
        val active: Boolean,
        val finished: Boolean,
        val refused: Boolean = false,
        val text: String
    )

    data class BasicSettingsResult(
        val success: Boolean,
        val measurement: LiveMeasurement? = null,
        val isNak: Boolean = false,
        val message: String
    )

    data class AdaptationResult(
        val success: Boolean,
        val channel: Int,
        val value: Int,
        val message: String
    )

    data class ImmoStatus(
        val startPermitted: Boolean,
        val ecuResponds: Boolean,
        val keyAuthorized: Boolean,
        val keyCount: Int,
        val rawSummary: String = "",
        val errorMessage: String? = null
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
        private val VAG_ACTUATOR_CODES = mapOf(
            "01249" to "Форсунка впрыска топлива (N30)\n→ Прислушайтесь к форсунке моновпрыска: должны раздаваться ритмичные щелчки.",
            "01247" to "Клапан продувки адсорбера (N80)\n→ Клапан на правом брызговике должен тактированно щёлкать.",
            "00282" to "Регулятор положения дроссельной заслонки / РХХ (V60)\n→ Сервопривод РХХ плавно выдвигает и втягивает шток заслонки.",
            "00670" to "Регулятор холостого хода / Датчик положения (V60 / G88)\n→ Сервопривод РХХ выполняет ход проверки штока.",
            "01259" to "Реле топливного насоса (J17)\n→ Кратковременное включение бензонасоса и подогрева коллектора.",
            "01250" to "Реле топливного насоса / Форсунка\n→ Активация исполнительной цепи питания топлива."
        )

        val ALL_KNOWN_DTCS = mapOf(
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
                remedy = "Покачать моновпрыск рукой на работающем моторе. Проверить давление топлива (0.8–1.2 бар для Mono-Motronic). Выполнить сброс в Адаптации (Канал 00)."
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
                remedy = "Произвести адаптацию блока управления двигателем к иммобилайзеру: Иммобилайзер (0x25) → Адаптация → Канал 00 → Сохранить (значение 0), выключить зажигание на 30 сек."
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
                consecutiveKeepAliveErrors = 0
                preferredGroupReadCmd = null
                blockCounter = 0
                ecuPartNumber = ""
                ecuComponent = ""
                ecuExtra = ""
                activeAddress = targetAddr

                val blockName = if (targetAddr == 0x25) "Иммобилайзер (0x25)" else "ЭБУ Двигателя (0x01)"
                onLog("Подключение: $blockName...")

                val speeds = if (targetAddr == 0x25) listOf(9600) else listOf(9600, 10400)
                for (speed in speeds) {
                    if (tryConnectSpeed(targetAddr, speed, onLog)) {
                        negotiatedBaud = speed
                        isSessionActive = true
                        startKeepAlive()
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
            if (b == 0x55) {
                syncFound = true
                break
            }
        }

        if (!syncFound) return false

        val kb1 = driver.readByte(1000)
        if (kb1 < 0) return false
        val kb2 = driver.readByte(1000)
        if (kb2 < 0) return false

        delay(35)
        val comp = ((kb2 xor 0xFF) and 0xFF).toByte()
        driver.writeRawByte(comp, 300)

        return readIdentificationBlocks(onLog)
    }

    /**
     * Чтение блоков идентификации 0xF6 до завершающего 0x09 от ЭБУ.
     * На 0x09 выходим без отправки ACK — очередь передачи переходит к тестеру.
     */
    private suspend fun readIdentificationBlocks(onLog: (String) -> Unit): Boolean {
        var blocksRead = 0
        while (blocksRead < 10) {
            val block = receiveBlockInternal(2000) ?: break
            blocksRead++

            if (block.title == 0xF6 || block.title == 0x00) {
                val text = String(block.data, Charsets.US_ASCII).trim()
                when (blocksRead) {
                    1 -> { ecuPartNumber = text; onLog("Номер: $text") }
                    2 -> { ecuComponent = text; onLog("Компонент: $text") }
                    3 -> { ecuExtra = text; onLog("Кодировка: $text") }
                    else -> if (text.isNotEmpty()) onLog("Инфо: $text")
                }
                if (!sendBlockInternal(0x09)) return false
            } else if (block.title == 0x09) {
                // Конец паспорта, очередь тестера
                return true
            } else {
                if (!sendBlockInternal(0x09)) return false
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
        delay(2)

        val counter = driver.readByte(400)
        if (counter < 0) return null
        sendByteAck(counter)
        delay(2)

        val title = driver.readByte(400)
        if (title < 0) return null
        sendByteAck(title)
        delay(2)

        val dataLen = len - 3
        val data = ByteArray(dataLen)
        for (i in 0 until dataLen) {
            val d = driver.readByte(400)
            if (d < 0) return null
            data[i] = d.toByte()
            sendByteAck(d)
            delay(2)
        }

        // Конец блока 0x03 (не подтверждается инверсией)
        driver.readByte(400)
        delay(6)

        blockCounter = counter
        return KwBlock(len, counter, title, data)
    }

    private suspend fun sendByteAck(b: Int) {
        val comp = ((b xor 0xFF) and 0xFF).toByte()
        driver.writeRawByte(comp, 200)
    }

    private fun startKeepAlive() {
        stopKeepAliveInternal()
        keepAliveJob = CoroutineScope(Dispatchers.IO).launch {
            while (isActive && isSessionActive) {
                delay(450)
                if (!isSessionActive) break
                try {
                    busMutex.withLock {
                        if (isSessionActive) {
                            val ok = sendBlockInternal(0x09)
                            val reply = if (ok) receiveBlockInternal(1000) else null
                            if (ok && reply != null) {
                                consecutiveKeepAliveErrors = 0
                            } else {
                                consecutiveKeepAliveErrors++
                                if (consecutiveKeepAliveErrors >= 6) {
                                    isSessionActive = false
                                }
                            }
                        }
                    }
                } catch (t: Throwable) {
                    consecutiveKeepAliveErrors++
                }
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
                    sendBlockInternal(0x06)
                    delay(40)
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
                if (!isSessionActive) return@withContext faults
                val sent = sendBlockInternal(0x07)
                if (!sent) {
                    onLog("Ошибка отправки команды 0x07")
                    return@withContext faults
                }

                while (true) {
                    val block = receiveBlockInternal(2000) ?: break

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
                        // Запрашиваем следующий блок ошибок (или конец списка)
                        if (!sendBlockInternal(0x09)) break
                    } else if (block.title == 0x09 || block.title == 0x0A) {
                        // Конец списка ошибок — очередь тестера
                        break
                    } else {
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
                if (!isSessionActive) return@withContext false
                val sent = sendBlockInternal(0x05)
                if (!sent) return@withContext false

                var steps = 0
                while (steps < 4) {
                    steps++
                    val reply = receiveBlockInternal(2000) ?: return@withContext false
                    if (reply.title == 0xFC) {
                        if (!sendBlockInternal(0x09)) break
                    } else {
                        // Получен 0x09 или 0x0A — очередь тестера
                        return@withContext reply.title == 0x09
                    }
                }
                true
            } catch (t: Throwable) {
                false
            }
        }
    }

    /**
     * Тест исполнительных механизмов (Команда 0x04)
     * Keep-alive продолжает работать между нажатиями пользователя,
     * так как все операции синхронизированы через busMutex.
     */
    suspend fun stepActuatorTest(onLog: (String) -> Unit): ActuatorStepResult = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                if (!isSessionActive) {
                    return@withContext ActuatorStepResult(
                        active = false,
                        finished = true,
                        text = "Сеанс связи с ЭБУ не активен. Подключитесь заново."
                    )
                }

                val sent = sendBlockInternal(0x04)
                if (!sent) {
                    return@withContext ActuatorStepResult(
                        active = false,
                        finished = true,
                        text = "Ошибка обмена: ЭБУ не принял команду 0x04."
                    )
                }

                val reply = receiveBlockInternal(2500)
                if (reply == null) {
                    return@withContext ActuatorStepResult(
                        active = false,
                        finished = true,
                        text = "Таймаут ответа ЭБУ на тест исполнителей (0x04)."
                    )
                }

                when (reply.title) {
                    0xF5 -> {
                        val desc = decodeActuatorPayload(reply.data)
                        ActuatorStepResult(active = true, finished = false, text = desc)
                    }
                    0x09 -> {
                        ActuatorStepResult(
                            active = false,
                            finished = true,
                            text = "Тест исполнительных механизмов завершён (все элементы проверены)."
                        )
                    }
                    0x0A -> {
                        ActuatorStepResult(
                            active = false,
                            finished = true,
                            refused = true,
                            text = "ЭБУ отклонил тест исполнителей (NAK 0x0A).\n• Убедитесь, что двигатель ЗАГЛУШЕН (0 об/мин), а зажигание включено!"
                        )
                    }
                    else -> {
                        ActuatorStepResult(
                            active = false,
                            finished = true,
                            text = "Неожиданный ответ ЭБУ: Title 0x%02X".format(reply.title)
                        )
                    }
                }
            } catch (t: Throwable) {
                ActuatorStepResult(
                    active = false,
                    finished = true,
                    text = "Ошибка теста исполнителей: ${t.message ?: t.javaClass.simpleName}"
                )
            }
        }
    }

    /**
     * Штатное завершение теста исполнителей в KWP1281 (пролистывание шагов 0x04 до 0x09)
     */
    suspend fun finishActuatorTest(): Boolean = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                if (!isSessionActive) return@withContext false
                for (i in 0 until 8) {
                    if (!sendBlockInternal(0x04)) return@withContext false
                    val reply = receiveBlockInternal(2000) ?: return@withContext false
                    if (reply.title == 0x09 || reply.title == 0x0A) {
                        return@withContext true
                    }
                    delay(40)
                }
                true
            } catch (t: Throwable) {
                false
            }
        }
    }

    private fun decodeActuatorPayload(data: ByteArray): String {
        if (data.size == 2) {
            val code = ((data[0].toInt() and 0xFF) shl 8) or (data[1].toInt() and 0xFF)
            val vagCode = "%05d".format(code)
            return VAG_ACTUATOR_CODES[vagCode]
                ?: "Активен исполнительный механизм VAG $vagCode\n→ Проверьте срабатывание элемента под капотом."
        }
        val ascii = String(data, Charsets.US_ASCII).trim()
        if (ascii.isNotEmpty() && ascii.all { it.code in 32..126 }) {
            // Проверка на присутствие кода VAG в строке
            for ((code, desc) in VAG_ACTUATOR_CODES) {
                if (ascii.contains(code)) return "$ascii\n$desc"
            }
            return "Активен исполнитель: $ascii"
        }
        val hex = data.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }
        return "Активен тест исполнителя (данные: $hex)"
    }

    private fun extractImmoInt(f: MeasuredField): Int {
        return when (f.formula) {
            0x25, 0x10 -> f.b
            0x0A -> if (f.b != 0 || f.a != 0) 1 else 0
            0x11 -> {
                val clean = f.valueText.trim()
                clean.toIntOrNull() ?: if (clean.contains("1") || clean.equals("YES", true) || clean.equals("ДА", true)) 1 else 0
            }
            else -> {
                val rounded = f.numericValue.roundToInt()
                if (rounded != 0 || (f.a == 0 && f.b == 0)) rounded else if (f.b in 0..10) f.b else rounded
            }
        }
    }

    /**
     * Чтение статуса иммобилайзера (Группа 001 блока 0x25: 1H0 953 257)
     */
    suspend fun readImmobilizerStatus(onLog: (String) -> Unit): ImmoStatus = withContext(Dispatchers.IO) {
        val m1 = readMeasuringGroup(1, onLog)
        if (m1 == null) {
            return@withContext ImmoStatus(
                startPermitted = false,
                ecuResponds = false,
                keyAuthorized = false,
                keyCount = 0,
                errorMessage = "Нет ответа от иммобилайзера на запрос Группы 001"
            )
        }
        if (m1.errorMessage != null || m1.isUnsupportedNak) {
            return@withContext ImmoStatus(
                startPermitted = false,
                ecuResponds = false,
                keyAuthorized = false,
                keyCount = 0,
                errorMessage = m1.errorMessage ?: "Группа 001 не поддерживается"
            )
        }

        val summary = if (m1.fields.isNotEmpty()) {
            m1.fields.joinToString(" | ") { "${it.valueText} [0x%02X:%d,%d]".format(it.formula, it.a, it.b) }
        } else {
            m1.rawValues.joinToString(" ") { "%03d".format(it) }
        }

        if (m1.fields.size >= 4) {
            return@withContext ImmoStatus(
                startPermitted = extractImmoInt(m1.fields[0]) >= 1,
                ecuResponds = extractImmoInt(m1.fields[1]) >= 1,
                keyAuthorized = extractImmoInt(m1.fields[2]) >= 1,
                keyCount = extractImmoInt(m1.fields[3]),
                rawSummary = summary
            )
        }

        if (m1.fields.size == 3) {
            // На некоторых прошивках 1H0 953 257 число ключей или таймер блокировки в Группе 002
            val m2 = readMeasuringGroup(2, onLog)
            val keyCnt = if (m2 != null && m2.errorMessage == null && m2.fields.isNotEmpty()) {
                extractImmoInt(m2.fields.last())
            } else {
                0
            }
            return@withContext ImmoStatus(
                startPermitted = extractImmoInt(m1.fields[0]) >= 1,
                ecuResponds = extractImmoInt(m1.fields[1]) >= 1,
                keyAuthorized = extractImmoInt(m1.fields[2]) >= 1,
                keyCount = keyCnt,
                rawSummary = summary
            )
        }

        if (m1.rawValues.size >= 4) {
            return@withContext ImmoStatus(
                startPermitted = m1.rawValues[0] >= 1,
                ecuResponds = m1.rawValues[1] >= 1,
                keyAuthorized = m1.rawValues[2] >= 1,
                keyCount = m1.rawValues[3],
                rawSummary = summary
            )
        }

        ImmoStatus(
            startPermitted = false,
            ecuResponds = false,
            keyAuthorized = false,
            keyCount = 0,
            rawSummary = summary,
            errorMessage = "Нестандартный формат Группы 001 ($summary)"
        )
    }

    /**
     * Чтение группы измерительных величин Live Data (Команда 0x29 / 0x08)
     */
    suspend fun readMeasuringGroup(group: Int = 1, onLog: (String) -> Unit): LiveMeasurement? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            readMeasuringGroupUnlocked(group, onLog)
        }
    }

    private fun isMeasuringBlockTitle(title: Int): Boolean {
        return title == 0xE7 || title == 0xF4 || title == 0x02 || title == 0xFE
    }

    private suspend fun readMeasuringGroupUnlocked(group: Int, onLog: (String) -> Unit): LiveMeasurement? {
        try {
            if (!isSessionActive) {
                return LiveMeasurement(group = group, errorMessage = "Сеанс связи закрыт")
            }

            if (group == 0) {
                // Группа 000: пробуем 0x29 без аргументов, 0x29 [0x00] и 0x08 [0x00]
                val attempts: List<Pair<Int, ByteArray>> = listOf(
                    0x29 to ByteArray(0),
                    0x29 to byteArrayOf(0x00),
                    0x08 to byteArrayOf(0x00)
                )
                var lastTitle = -1
                for ((cmd, payload) in attempts) {
                    if (!sendBlockInternal(cmd, payload)) continue
                    val reply = receiveBlockInternal(2000) ?: continue
                    lastTitle = reply.title
                    if (isMeasuringBlockTitle(reply.title)) {
                        return parseMeasuringBlock(reply.data, 0)
                    }
                }
                if (lastTitle == 0x0A) {
                    return LiveMeasurement(group = 0, isUnsupportedNak = true, errorMessage = "Группа 000 отклонена (NAK 0x0A)")
                }
                return LiveMeasurement(group = 0, errorMessage = "Нет ответа ЭБУ на запрос Группы 000")
            }

            val cmdsToTry = preferredGroupReadCmd?.let { listOf(it) } ?: listOf(0x29, 0x08)
            var lastReplyTitle = -1
            var anyReplyReceived = false

            for (cmd in cmdsToTry) {
                if (!sendBlockInternal(cmd, byteArrayOf(group.toByte()))) continue
                val reply = receiveBlockInternal(2000) ?: continue
                anyReplyReceived = true
                lastReplyTitle = reply.title

                if (isMeasuringBlockTitle(reply.title)) {
                    preferredGroupReadCmd = cmd
                    return parseMeasuringBlock(reply.data, group)
                }
            }

            if (!anyReplyReceived) {
                return LiveMeasurement(group = group, errorMessage = "Таймаут чтения группы %03d".format(group))
            }

            return when (lastReplyTitle) {
                0x0A -> LiveMeasurement(
                    group = group,
                    isUnsupportedNak = true,
                    errorMessage = "Группа %03d не поддерживается блоком (NAK 0x0A)".format(group)
                )
                0x09 -> LiveMeasurement(group = group, errorMessage = "Группа %03d: пустой ответ (0x09)".format(group))
                else -> LiveMeasurement(
                    group = group,
                    errorMessage = "Неожиданный блок 0x%02X на группу %03d".format(lastReplyTitle, group)
                )
            }
        } catch (t: Throwable) {
            onLog("Ошибка чтения группы %03d: ${t.message}".format(group))
            return LiveMeasurement(group = group, errorMessage = t.message)
        }
    }

    /**
     * Базовые установки (Команда 0x28 [group], для ранних блоков фоллбек 0x28 без аргументов / 0x11)
     */
    suspend fun enterBasicSettings(group: Int = 0, onLog: (String) -> Unit): BasicSettingsResult = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                if (!isSessionActive) {
                    return@withContext BasicSettingsResult(false, message = "Сеанс связи с ЭБУ не активен.")
                }

                val attempts: MutableList<Pair<Int, ByteArray>> = mutableListOf(
                    0x28 to byteArrayOf(group.toByte())
                )
                if (group == 0) {
                    attempts.add(0x28 to ByteArray(0))
                    attempts.add(0x11 to ByteArray(0))
                }

                var sawNak = false
                var lastTitle = -1

                for ((attemptIdx, pair) in attempts.withIndex()) {
                    val (cmd, payload) = pair
                    if (attemptIdx > 0) delay(50)
                    if (!sendBlockInternal(cmd, payload)) continue
                    val reply = receiveBlockInternal(2000) ?: continue
                    lastTitle = reply.title

                    when {
                        isMeasuringBlockTitle(reply.title) -> {
                            val m = parseMeasuringBlock(reply.data, group)
                            return@withContext BasicSettingsResult(
                                success = true,
                                measurement = m,
                                message = "Базовые установки группы %03d активны!".format(group)
                            )
                        }
                        reply.title == 0x09 -> {
                            return@withContext BasicSettingsResult(
                                success = true,
                                measurement = LiveMeasurement(group = group),
                                message = "Режим базовых установок подтверждён ЭБУ (0x09)."
                            )
                        }
                        reply.title == 0xFC -> {
                            return@withContext BasicSettingsResult(
                                success = false,
                                isNak = true,
                                message = "ЭБУ не пускает в Базовые установки (в памяти активны ошибки 0xFC). Прочитайте и сотрите ошибки (07 → 05)."
                            )
                        }
                        reply.title == 0x0A -> {
                            sawNak = true
                        }
                    }
                }

                if (sawNak) {
                    return@withContext BasicSettingsResult(
                        success = false,
                        isNak = true,
                        message = "ЭБУ отклонил Базовые установки группы %03d (NAK 0x0A).".format(group)
                    )
                }

                if (lastTitle >= 0) {
                    return@withContext BasicSettingsResult(
                        success = false,
                        message = "Неожиданный ответ ЭБУ на Базовые установки: Title 0x%02X".format(lastTitle)
                    )
                }

                BasicSettingsResult(
                    success = false,
                    message = "Таймаут ответа ЭБУ на Базовые установки (0x28)."
                )
            } catch (t: Throwable) {
                BasicSettingsResult(false, message = "Ошибка входа в Базовые установки: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    /**
     * АДАПТАЦИЯ: Чтение канала (0x21)
     */
    suspend fun readAdaptation(channel: Int): AdaptationResult = withContext(Dispatchers.IO) {
        executeAdaptationCommand(0x21, channel, 0, "Чтение")
    }

    /**
     * АДАПТАЦИЯ: Проверка значения в канале без сохранения (0x22)
     */
    suspend fun testAdaptation(channel: Int, value: Int): AdaptationResult = withContext(Dispatchers.IO) {
        executeAdaptationCommand(0x22, channel, value, "Тест")
    }

    /**
     * АДАПТАЦИЯ: Сохранение значения в память ЭБУ (0x2A)
     */
    suspend fun saveAdaptation(channel: Int, value: Int): AdaptationResult = withContext(Dispatchers.IO) {
        executeAdaptationCommand(0x2A, channel, value, "Сохранение")
    }

    private suspend fun executeAdaptationCommand(
        cmd: Int,
        channel: Int,
        value: Int,
        opName: String
    ): AdaptationResult {
        return busMutex.withLock {
            try {
                if (!isSessionActive) {
                    return@withLock AdaptationResult(false, channel, value, "Сеанс связи с блоком не активен.")
                }

                val payload = if (cmd == 0x21) {
                    byteArrayOf(channel.toByte())
                } else {
                    byteArrayOf(
                        channel.toByte(),
                        ((value shr 8) and 0xFF).toByte(),
                        (value and 0xFF).toByte()
                    )
                }

                if (!sendBlockInternal(cmd, payload)) {
                    return@withLock AdaptationResult(false, channel, value, "Ошибка передачи команды адаптации 0x%02X.".format(cmd))
                }

                val reply = receiveBlockInternal(2500)
                    ?: return@withLock AdaptationResult(false, channel, value, "Таймаут ответа блока на команду $opName (канал %02d).".format(channel))

                when (reply.title) {
                    0xE6 -> {
                        val ch = if (reply.data.isNotEmpty()) (reply.data[0].toInt() and 0xFF) else channel
                        val decodedVal = if (reply.data.size >= 3) {
                            ((reply.data[1].toInt() and 0xFF) shl 8) or (reply.data[2].toInt() and 0xFF)
                        } else if (reply.data.size == 2) {
                            reply.data[1].toInt() and 0xFF
                        } else {
                            value
                        }
                        AdaptationResult(
                            success = true,
                            channel = ch,
                            value = decodedVal,
                            message = "$opName успешно: Канал %02d = $decodedVal".format(ch)
                        )
                    }
                    0x09 -> {
                        AdaptationResult(
                            success = true,
                            channel = channel,
                            value = value,
                            message = "$opName выполнено: Канал %02d (подтверждение 0x09)".format(channel)
                        )
                    }
                    0x0A -> {
                        AdaptationResult(
                            success = false,
                            channel = channel,
                            value = value,
                            message = "Канал %02d недоступен или операция отклонена блоком (NAK 0x0A).".format(channel)
                        )
                    }
                    else -> {
                        AdaptationResult(
                            success = false,
                            channel = channel,
                            value = value,
                            message = "Ответ блока на адаптацию: Title 0x%02X".format(reply.title)
                        )
                    }
                }
            } catch (t: Throwable) {
                AdaptationResult(false, channel, value, "Ошибка адаптации: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    /**
     * Полное декодирование измерительных блоков KWP1281 (0xE7 / 0xF4 / 0x02)
     */
    private fun parseMeasuringBlock(data: ByteArray, group: Int): LiveMeasurement {
        val raw = data.map { it.toInt() and 0xFF }

        // Вариант 1: 10 сырых байт группы 000 Bosch Mono-Motronic 1.2.3
        if (data.size == 10) {
            val coolantRaw = raw[0]
            val throttleRaw = raw[1]
            val rpmRaw = raw[2]
            val lambdaRaw = raw[4]
            val batteryRaw = raw[8]

            // На Mono-Motronic 1.2.3 ДТОЖ в группе 000 может быть прямым (>=60 при прогреве) или инверсным NTC (<=45 при 85-100°C)
            val coolantC = if (coolantRaw > 60) {
                (coolantRaw * 0.65 - 30.0).toInt()
            } else {
                (115.0 - coolantRaw * 1.4).toInt()
            }
            val rpm = rpmRaw * 25
            // Окно 5 в группе 000 Mono-Motronic — интегратор лямбда-регулирования (центр 128 = 0%)
            val lambdaCorr = ((lambdaRaw - 128) * 100.0 / 128.0).let { "%.1f".format(it).replace(',', '.').toDoubleOrNull() }
            val throttleAngle = (throttleRaw * 0.35).let { "%.1f".format(it).replace(',', '.').toDoubleOrNull() }
            val batteryV = (batteryRaw * 0.08).let { "%.1f".format(it).replace(',', '.').toDoubleOrNull() }

            val fields = raw.mapIndexed { i, v ->
                MeasuredField(i + 1, "%03d".format(v), 0, 0, v, v.toDouble())
            }

            return LiveMeasurement(
                group = group,
                rpm = rpm,
                coolantTemp = coolantC,
                lambdaCorrection = lambdaCorr,
                throttleAngle = throttleAngle,
                batteryVoltage = batteryV,
                rawValues = raw,
                fields = fields
            )
        }

        // Вариант 2: Тройки [формула][A][B] (до 4 полей в блоке 0xE7 / 0xF4)
        var parsedRpm: Int? = null
        var parsedCoolantTemp: Int? = null
        var parsedAirTemp: Int? = null
        var parsedLambdaV: Double? = null
        var parsedLambdaCorr: Double? = null
        var parsedThrottle: Double? = null
        var parsedBatteryV: Double? = null
        var parsedInjMs: Double? = null

        val fields = mutableListOf<MeasuredField>()
        var idx = 0
        var itemNum = 1

        while (idx + 2 < data.size && itemNum <= 4) {
            val formula = raw[idx]
            val a = raw[idx + 1]
            val b = raw[idx + 2]
            idx += 3

            val decoded = decodeFormula(formula, a, b)
            fields.add(MeasuredField(itemNum, decoded.displayText, formula, a, b, decoded.numeric))

            when (decoded.kind) {
                FieldKind.RPM -> if (parsedRpm == null) parsedRpm = decoded.numeric.toInt()
                FieldKind.TEMP -> {
                    // В группах 1, 4(поле 3), 5 это ОЖ; в группах 2(поле 4), 3(поле 4), 4(поле 4) это воздух
                    if (group == 1 || (group == 5 && itemNum == 2) || (group == 4 && itemNum == 3)) {
                        parsedCoolantTemp = decoded.numeric.toInt()
                    } else if (parsedCoolantTemp == null && itemNum <= 2) {
                        parsedCoolantTemp = decoded.numeric.toInt()
                    } else {
                        parsedAirTemp = decoded.numeric.toInt()
                    }
                }
                FieldKind.VOLTAGE -> {
                    if (decoded.numeric in 0.0..1.8) {
                        parsedLambdaV = decoded.numeric
                    } else if (decoded.numeric > 5.0) {
                        parsedBatteryV = decoded.numeric
                    }
                }
                FieldKind.LAMBDA_PCT -> parsedLambdaCorr = decoded.numeric
                FieldKind.ANGLE -> {
                    // В группе 3 поле 3 — угол открытия дроссельной заслонки (ДПДЗ G69)
                    if (group == 3 || parsedThrottle == null) {
                        parsedThrottle = decoded.numeric
                    }
                }
                FieldKind.LOAD_PCT -> {
                    // В группе 001 / 005 поле 3 у Mono-Motronic может передавать лямбда-коррекцию в %
                    if ((group == 1 || group == 5) && itemNum == 3 && parsedLambdaCorr == null) {
                        parsedLambdaCorr = decoded.numeric
                    }
                }
                FieldKind.INJ_MS -> parsedInjMs = decoded.numeric
                else -> {
                    // Запасная интерпретация по стандартной позиции поля Группы 001 / 005,
                    // если ЭБУ прислал нестандартный код формулы
                    if (group == 1 && itemNum == 2 && parsedCoolantTemp == null && decoded.numeric in -40.0..140.0) {
                        parsedCoolantTemp = decoded.numeric.toInt()
                    } else if ((group == 1 || group == 5) && itemNum == 3 && parsedLambdaV == null && parsedLambdaCorr == null) {
                        if (decoded.numeric in 0.0..1.5) {
                            parsedLambdaV = decoded.numeric
                        } else if (decoded.numeric in -50.0..150.0) {
                            parsedLambdaCorr = decoded.numeric
                        }
                    }
                }
            }
            itemNum++
        }

        return LiveMeasurement(
            group = group,
            rpm = parsedRpm,
            coolantTemp = parsedCoolantTemp,
            lambdaVoltage = parsedLambdaV,
            lambdaCorrection = parsedLambdaCorr,
            throttleAngle = parsedThrottle,
            batteryVoltage = parsedBatteryV,
            intakeAirTemp = parsedAirTemp,
            injectionTimeMs = parsedInjMs,
            rawValues = raw,
            fields = fields
        )
    }

    private enum class FieldKind {
        RPM, TEMP, VOLTAGE, LAMBDA_PCT, ANGLE, LOAD_PCT, INJ_MS, SPEED, BITS, OTHER
    }

    private data class DecodedFormula(
        val numeric: Double,
        val displayText: String,
        val kind: FieldKind
    )

    private fun decodeFormula(formula: Int, a: Int, b: Int): DecodedFormula {
        return when (formula) {
            0x01 -> {
                val v = 0.2 * a * b
                DecodedFormula(v, "${v.toInt()} об/мин", FieldKind.RPM)
            }
            0x02 -> {
                val v = 0.002 * a * b
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LOAD_PCT)
            }
            0x03 -> {
                val v = 0.002 * a * b
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            0x04 -> {
                val v = abs(b - 127) * 0.01 * a
                val dir = if (b < 127) "до ВМТ" else "после ВМТ"
                DecodedFormula(v, "%.1f° $dir".format(v), FieldKind.OTHER)
            }
            0x05 -> {
                val v = a * (b - 100) * 0.1
                DecodedFormula(v, "%.1f °C".format(v), FieldKind.TEMP)
            }
            0x06, 0x15, 0x2B, 0x42 -> {
                val v = 0.001 * a * b
                DecodedFormula(v, "%.2f В".format(v), FieldKind.VOLTAGE)
            }
            0x07 -> {
                val v = 0.01 * a * b
                DecodedFormula(v, "%.0f км/ч".format(v), FieldKind.SPEED)
            }
            0x08 -> {
                val v = 0.1 * a * b
                DecodedFormula(v, "%.1f".format(v), FieldKind.OTHER)
            }
            0x09 -> {
                val v = (b - 127) * 0.02 * a
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            0x0A -> {
                val txt = if (b == 0) "НЕТ / Хол." else "ДА / Прогр."
                DecodedFormula(b.toDouble(), txt, FieldKind.OTHER)
            }
            0x0B -> {
                val v = 0.0001 * a * b + 0.5
                DecodedFormula(v, "%.3f λ".format(v), FieldKind.LAMBDA_PCT)
            }
            0x0D -> {
                val v = (b - 127) * 0.001 * a
                DecodedFormula(v, "%.2f".format(v), FieldKind.OTHER)
            }
            0x0F -> {
                val v = 0.01 * a * b
                DecodedFormula(v, "%.2f мс".format(v), FieldKind.INJ_MS)
            }
            0x10 -> {
                val bin = Integer.toBinaryString(b).padStart(8, '0')
                DecodedFormula(b.toDouble(), bin, FieldKind.BITS)
            }
            0x11 -> {
                val c1 = if (a in 32..126) a.toChar() else ' '
                val c2 = if (b in 32..126) b.toChar() else ' '
                val txt = "$c1$c2".trim().ifEmpty { "$b" }
                DecodedFormula(txt.toDoubleOrNull() ?: b.toDouble(), txt, FieldKind.OTHER)
            }
            0x12 -> {
                val v = 0.04 * a * b
                DecodedFormula(v, "%.0f мбар".format(v), FieldKind.OTHER)
            }
            0x13 -> {
                val v = 0.01 * a * b
                DecodedFormula(v, "%.2f л".format(v), FieldKind.OTHER)
            }
            0x14 -> {
                val v = a * (b - 128) / 128.0
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LAMBDA_PCT)
            }
            0x16 -> {
                val v = 0.001 * a * b
                DecodedFormula(v, "%.2f мс".format(v), FieldKind.INJ_MS)
            }
            0x17 -> {
                val v = (b / 256.0) * a
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LOAD_PCT)
            }
            0x18 -> {
                val v = 0.001 * a * b
                DecodedFormula(v, "%.2f А".format(v), FieldKind.OTHER)
            }
            0x1A -> {
                val v = (b - a).toDouble()
                DecodedFormula(v, "%.0f °C".format(v), FieldKind.TEMP)
            }
            0x1B -> {
                val v = abs(b - 128) * 0.01 * a
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            0x1E -> {
                val v = (b / 12.0) * a
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            0x1F -> {
                val v = (b / 2560.0) * a
                DecodedFormula(v, "%.1f °C".format(v), FieldKind.TEMP)
            }
            0x20 -> {
                val v = (b - 128).toDouble()
                DecodedFormula(v, "%.0f".format(v), FieldKind.OTHER)
            }
            0x21 -> {
                val v = if (a == 0) 100.0 * b else (100.0 * b / a)
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LOAD_PCT)
            }
            0x22 -> {
                val v = (b - 128) * 0.01 * a
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LAMBDA_PCT)
            }
            0x25 -> {
                DecodedFormula(b.toDouble(), "$b", FieldKind.OTHER)
            }
            0x26 -> {
                val v = (b - 128) * 0.001 * a
                DecodedFormula(v, "%.2f".format(v), FieldKind.OTHER)
            }
            0x27 -> {
                val v = (b / 256.0) * a
                DecodedFormula(v, "%.1f мг".format(v), FieldKind.OTHER)
            }
            0x28 -> {
                val v = b * 0.1 - a
                DecodedFormula(v, "%.1f".format(v), FieldKind.OTHER)
            }
            0x2C -> {
                DecodedFormula(a.toDouble(), "%02d:%02d".format(a, b), FieldKind.OTHER)
            }
            0x2D, 0x37 -> {
                val v = if (formula == 0x2D) 0.01 * a * b else 0.005 * a * b
                DecodedFormula(v, "%.2f".format(v), FieldKind.OTHER)
            }
            0x2E -> {
                val v = (a * b - 3200) * 0.0027
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            0x2F -> {
                val v = (b - 128) * a.toDouble()
                DecodedFormula(v, "%.0f мс".format(v), FieldKind.INJ_MS)
            }
            0x31 -> {
                val v = (b / 4.0) * a * 0.1
                DecodedFormula(v, "%.1f".format(v), FieldKind.OTHER)
            }
            0x33 -> {
                val v = ((b - 128) / 255.0) * a
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LAMBDA_PCT)
            }
            0x34 -> {
                val v = b * 0.02 * a - a
                DecodedFormula(v, "%.1f".format(v), FieldKind.OTHER)
            }
            0x35 -> {
                val v = (b - 128) * 1.4222 + 0.006 * a
                DecodedFormula(v, "%.1f".format(v), FieldKind.OTHER)
            }
            0x36 -> {
                val v = (a * 256 + b).toDouble()
                DecodedFormula(v, "${a * 256 + b}", FieldKind.OTHER)
            }
            0x3B -> {
                val v = (a * 256 + b) / 512.0
                DecodedFormula(v, "%.3f".format(v), FieldKind.OTHER)
            }
            0x3E -> {
                val v = 0.256 * a * b
                DecodedFormula(v, "%.1f".format(v), FieldKind.OTHER)
            }
            0x40 -> {
                val v = (a + b).toDouble()
                DecodedFormula(v, "%.0f".format(v), FieldKind.OTHER)
            }
            0x41 -> {
                val v = 0.01 * a * (b - 127)
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            0x43 -> {
                val v = 0.1 * a * b
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            else -> {
                val v = a * 0.1 * b
                DecodedFormula(v, "0x%02X(%d/%d)".format(formula, a, b), FieldKind.OTHER)
            }
        }
    }
}
