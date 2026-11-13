/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import JSZip from 'jszip';

export interface AndroidProjectFile {
  path: string;
  filename: string;
  language: 'kotlin' | 'xml' | 'groovy' | 'markdown' | 'yaml' | 'properties';
  description: string;
  content: string;
}

export const ANDROID_PROJECT_FILES: AndroidProjectFile[] = [
  {
    path: '.github/workflows/build-apk.yml',
    filename: 'build-apk.yml',
    language: 'yaml',
    description: 'GitHub Actions воркфлоу для автоматической сборки APK в облаке GitHub',
    content: `name: Build Android APK (KW1281 Diag)

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
  workflow_dispatch: # Позволяет запускать сборку вручную кнопкой в GitHub UI

jobs:
  build:
    name: Build Debug APK
    runs-on: ubuntu-latest

    steps:
      - name: 1. Клонирование репозитория
        uses: actions/checkout@v4

      - name: 2. Установка Java JDK 17
        uses: actions/setup-java@v4
        with:
          java-version: '17'
      - name: 3. Установка Gradle 8.4
        run: |
          wget -q https://services.gradle.org/distributions/gradle-8.4-bin.zip
          unzip -q gradle-8.4-bin.zip
          echo "$GITHUB_WORKSPACE/gradle-8.4/bin" >> $GITHUB_PATH

      - name: 4. Компиляция Debug APK
        working-directory: android
        run: |
          export PATH="$GITHUB_WORKSPACE/gradle-8.4/bin:$PATH"
          export ANDROID_HOME="/usr/local/lib/android/sdk"
          export ANDROID_SDK_ROOT="/usr/local/lib/android/sdk"
          mkdir -p "$ANDROID_HOME/licenses" || true
          echo "24333f8a63b6825ea9c5514f83c2829b004d1fee" > "$ANDROID_HOME/licenses/android-sdk-license" || true
          echo "d56f5187479edd34eabfb83902802b63065e7a56" >> "$ANDROID_HOME/licenses/android-sdk-license" || true
          echo "84831b9409646a918e30573bab4c9c91346d8abd" > "$ANDROID_HOME/licenses/android-sdk-preview-license" || true
          gradle assembleDebug --stacktrace --no-daemon

      - name: 5. Выгрузка готового APK в артефакты
        uses: actions/upload-artifact@v4
        with:
          name: kw1281-vento-debug-apk
          path: android/app/build/outputs/apk/debug/app-debug.apk
          retention-days: 14
`
  },
  {
    path: 'app/src/main/java/com/vag/kw1281/Ftdi5BaudDriver.kt',
    filename: 'Ftdi5BaudDriver.kt',
    language: 'kotlin',
    description: 'Отказоустойчивый высокоточный драйвер K-Line / FTDI FT232 для KW1281 (200.0 мс/бит)',
    content: `package com.vag.kw1281

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
            lastError = "\${t.javaClass.simpleName}: \${t.message}"
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
            lastError = "setBreak error: \${t.message}"
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
            lastError = "setUartMode error: \${t.message}"
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
            lastError = "\${t.javaClass.simpleName}: \${t.message}"
            onLog("Ошибка 5-бодовой посылки: \${t.message ?: t.javaClass.simpleName}")
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
                lastError = "\${t.javaClass.simpleName}: \${t.message}"
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
                lastError = "\${t.javaClass.simpleName}: \${t.message}"
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
`
  },
  {
    path: 'app/src/main/java/com/vag/kw1281/Kw1281Protocol.kt',
    filename: 'Kw1281Protocol.kt',
    language: 'kotlin',
    description: 'Машина состояний протокола KWP1281 с подтверждением инверсией и Keep-Alive',
    content: `package com.vag.kw1281

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
        val b: Int
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
        private val VAG_ACTUATOR_CODES = mapOf(
            "01249" to "Форсунка впрыска топлива (N30)\\n→ Прислушайтесь к форсунке моновпрыска: должны раздаваться ритмичные щелчки.",
            "01247" to "Клапан продувки адсорбера (N80)\\n→ Клапан на правом брызговике должен тактированно щёлкать.",
            "00282" to "Регулятор положения дроссельной заслонки / РХХ (V60)\\n→ Сервопривод РХХ плавно выдвигает и втягивает шток заслонки.",
            "00670" to "Регулятор холостого хода / Датчик положения (V60 / G88)\\n→ Сервопривод РХХ выполняет ход проверки штока.",
            "01259" to "Реле топливного насоса (J17)\\n→ Кратковременное включение бензонасоса и подогрева коллектора.",
            "01250" to "Реле топливного насоса / Форсунка\\n→ Активация исполнительной цепи питания топлива."
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
                onLog("Исключение сессии KWP1281: \${t.message ?: t.javaClass.simpleName}")
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
                onLog("Ошибка чтения DTC: \${t.message ?: t.javaClass.simpleName}")
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
                            text = "ЭБУ отклонил тест исполнителей (NAK 0x0A).\\n• Убедитесь, что двигатель ЗАГЛУШЕН (0 об/мин), а зажигание включено!"
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
                    text = "Ошибка теста исполнителей: \${t.message ?: t.javaClass.simpleName}"
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
                ?: "Активен исполнительный механизм VAG $vagCode\\n→ Проверьте срабатывание элемента под капотом."
        }
        val ascii = String(data, Charsets.US_ASCII).trim()
        if (ascii.isNotEmpty() && ascii.all { it.code in 32..126 }) {
            // Проверка на присутствие кода VAG в строке
            for ((code, desc) in VAG_ACTUATOR_CODES) {
                if (ascii.contains(code)) return "$ascii\\n$desc"
            }
            return "Активен исполнитель: $ascii"
        }
        val hex = data.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }
        return "Активен тест исполнителя (данные: $hex)"
    }

    /**
     * Чтение статуса иммобилайзера (Группа 001 блока 0x25)
     */
    suspend fun readImmobilizerStatus(onLog: (String) -> Unit): ImmoStatus? = withContext(Dispatchers.IO) {
        val m = readMeasuringGroup(1, onLog) ?: return@withContext null
        if (m.errorMessage != null || m.isUnsupportedNak) return@withContext null

        // В группе 001 иммобилайзера 1H0 953 257 приходят 4 значения:
        // Поле 1: разрешение пуска (0/1), Поле 2: ответ ЭБУ (0/1), Поле 3: ключ авторизован (0/1), Поле 4: кол-во ключей
        if (m.fields.size >= 4) {
            return@withContext ImmoStatus(
                startPermitted = m.fields[0].b == 1,
                ecuResponds = m.fields[1].b == 1,
                keyAuthorized = m.fields[2].b == 1,
                keyCount = m.fields[3].b
            )
        }
        if (m.rawValues.size >= 4) {
            return@withContext ImmoStatus(
                startPermitted = m.rawValues[0] == 1,
                ecuResponds = m.rawValues[1] == 1,
                keyAuthorized = m.rawValues[2] == 1,
                keyCount = m.rawValues[3]
            )
        }
        null
    }

    /**
     * Чтение группы измерительных величин Live Data (Команда 0x08 или 0x29 для Группы 000)
     */
    suspend fun readMeasuringGroup(group: Int = 1, onLog: (String) -> Unit): LiveMeasurement? = withContext(Dispatchers.IO) {
        busMutex.withLock {
            readMeasuringGroupUnlocked(group, onLog)
        }
    }

    private suspend fun readMeasuringGroupUnlocked(group: Int, onLog: (String) -> Unit): LiveMeasurement? {
        try {
            if (!isSessionActive) {
                return LiveMeasurement(group = group, errorMessage = "Сеанс связи закрыт")
            }

            var sent = sendBlockInternal(0x08, byteArrayOf(group.toByte()))
            if (!sent) {
                return LiveMeasurement(group = group, errorMessage = "Нет ответа шины на запрос группы %03d".format(group))
            }

            var reply = receiveBlockInternal(2000)

            // Для Группы 000 старые ЭБУ Bosch Mono-Motronic используют команду 0x29 без аргументов
            if (group == 0 && (reply == null || reply.title == 0x0A)) {
                sent = sendBlockInternal(0x29)
                if (sent) {
                    reply = receiveBlockInternal(2000)
                }
            }

            if (reply == null) {
                return LiveMeasurement(group = group, errorMessage = "Таймаут чтения группы %03d".format(group))
            }

            return when (reply.title) {
                0xE7, 0xF4, 0x02 -> parseMeasuringBlock(reply.data, group)
                0x0A -> LiveMeasurement(
                    group = group,
                    isUnsupportedNak = true,
                    errorMessage = "Группа %03d не поддерживается ЭБУ (NAK 0x0A)".format(group)
                )
                0x09 -> LiveMeasurement(group = group, errorMessage = "Группа %03d: пустой ответ (0x09)".format(group))
                else -> LiveMeasurement(
                    group = group,
                    errorMessage = "Неожиданный блок 0x%02X на группу %03d".format(reply.title, group)
                )
            }
        } catch (t: Throwable) {
            onLog("Ошибка чтения группы %03d: \${t.message}".format(group))
            return LiveMeasurement(group = group, errorMessage = t.message)
        }
    }

    /**
     * Базовые установки (Команда 0x28 или 0x11 для Группы 000)
     */
    suspend fun enterBasicSettings(group: Int = 0, onLog: (String) -> Unit): BasicSettingsResult = withContext(Dispatchers.IO) {
        busMutex.withLock {
            try {
                if (!isSessionActive) {
                    return@withContext BasicSettingsResult(false, message = "Сеанс связи с ЭБУ не активен.")
                }

                var sent = sendBlockInternal(0x28, byteArrayOf(group.toByte()))
                if (!sent) {
                    return@withContext BasicSettingsResult(false, message = "Ошибка передачи команды Базовых установок (0x28).")
                }

                var reply = receiveBlockInternal(2500)

                // Фоллбек на команду 0x11 (Базовые установки группы 000 на ранних Bosch Mono-Motronic 1.2.3)
                if (group == 0 && (reply == null || reply.title == 0x0A)) {
                    sent = sendBlockInternal(0x11)
                    if (sent) {
                        reply = receiveBlockInternal(2500)
                    }
                }

                if (reply == null) {
                    return@withContext BasicSettingsResult(false, message = "Таймаут ответа ЭБУ на Базовые установки (0x28 / 0x11).")
                }

                return@withContext when (reply.title) {
                    0xE7, 0xF4, 0x02 -> {
                        val m = parseMeasuringBlock(reply.data, group)
                        BasicSettingsResult(
                            success = true,
                            measurement = m,
                            message = "Базовые установки группы %03d активны!".format(group)
                        )
                    }
                    0x09 -> BasicSettingsResult(
                        success = true,
                        measurement = LiveMeasurement(group = group),
                        message = "Режим базовых установок подтверждён ЭБУ (0x09)."
                    )
                    0x0A -> BasicSettingsResult(
                        success = false,
                        message = "ЭБУ отклонил Базовые установки (NAK 0x0A).\\n• Для Группы 000/001 двигатель должен быть заведён на ХХ и прогрет (>80°C), педаль газа отпущена."
                    )
                    else -> BasicSettingsResult(
                        success = false,
                        message = "Неожиданный ответ ЭБУ: Title 0x%02X".format(reply.title)
                    )
                }
            } catch (t: Throwable) {
                BasicSettingsResult(false, message = "Ошибка входа в Базовые установки: \${t.message ?: t.javaClass.simpleName}")
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
                AdaptationResult(false, channel, value, "Ошибка адаптации: \${t.message ?: t.javaClass.simpleName}")
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

            val coolantC = (coolantRaw * 0.65 - 30.0).toInt()
            val rpm = if (rpmRaw <= 45) rpmRaw * 25 else rpmRaw * 10
            val lambdaV = (lambdaRaw * 0.005).let { "%.2f".format(it).replace(',', '.').toDoubleOrNull() }
            val throttleAngle = (throttleRaw * 0.35).let { "%.1f".format(it).replace(',', '.').toDoubleOrNull() }
            val batteryV = (batteryRaw * 0.08).let { "%.1f".format(it).replace(',', '.').toDoubleOrNull() }

            val fields = raw.mapIndexed { i, v ->
                MeasuredField(i + 1, "%03d".format(v), 0, 0, v)
            }

            return LiveMeasurement(
                group = group,
                rpm = rpm,
                coolantTemp = coolantC,
                lambdaVoltage = lambdaV,
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
            fields.add(MeasuredField(itemNum, decoded.displayText, formula, a, b))

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
                    if (group == 3 && itemNum == 2 && parsedThrottle == null) {
                        // Если угол отдельно не пришёл, но есть нагрузка дросселя
                    }
                }
                FieldKind.INJ_MS -> parsedInjMs = decoded.numeric
                else -> {}
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
                DecodedFormula(v, "\${v.toInt()} об/мин", FieldKind.RPM)
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
            0x06, 0x15, 0x42 -> {
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
            0x0B -> {
                val v = 0.0001 * a * b + 0.5
                DecodedFormula(v, "%.3f λ".format(v), FieldKind.LAMBDA_PCT)
            }
            0x0F -> {
                val v = 0.01 * a * b
                DecodedFormula(v, "%.2f мс".format(v), FieldKind.INJ_MS)
            }
            0x10 -> {
                val bin = Integer.toBinaryString(b).padStart(8, '0')
                DecodedFormula(b.toDouble(), bin, FieldKind.BITS)
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
            0x21 -> {
                val v = if (a == 0) 100.0 * b else (100.0 * b / a)
                DecodedFormula(v, "%.1f %%".format(v), FieldKind.LOAD_PCT)
            }
            0x2B -> {
                val v = a * b * 0.001
                DecodedFormula(v, "%.2f В".format(v), FieldKind.VOLTAGE)
            }
            0x43 -> {
                val v = 0.1 * a * b
                DecodedFormula(v, "%.1f°".format(v), FieldKind.ANGLE)
            }
            else -> {
                val v = a * 0.1 * b
                DecodedFormula(v, "$a / $b", FieldKind.OTHER)
            }
        }
    }
}
`
  },
  {
    path: 'app/src/main/res/layout/activity_main.xml',
    filename: 'activity_main.xml',
    language: 'xml',
    description: 'Разметка интерфейса с фиксированной скоростью 9600 бод и журналом KW1281',
    content: `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
    android:layout_width="match_parent"
    android:layout_height="match_parent"
    android:orientation="vertical"
    android:background="#090D16"
    android:padding="12dp">

    <!-- Top App Header -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:layout_marginBottom="8dp">

        <ImageView
            android:layout_width="44dp"
            android:layout_height="44dp"
            android:src="@drawable/ic_launcher"
            android:layout_marginEnd="10dp"
            android:contentDescription="VW Vento" />

        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="VENTO DIAGNOSTIC"
                android:textColor="#38BDF8"
                android:textSize="18sp"
                android:textStyle="bold"
                android:typeface="monospace" />

            <TextView
                android:id="@+id/tvSubtitle"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="VW Vento 1995 1.8 ADZ • KWP1281"
                android:textColor="#94A3B8"
                android:textSize="11sp" />
        </LinearLayout>

        <TextView
            android:id="@+id/tvBaudBadge"
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="9600 бод"
            android:textColor="#38BDF8"
            android:background="#1E293B"
            android:paddingStart="8dp"
            android:paddingEnd="8dp"
            android:paddingTop="4dp"
            android:paddingBottom="4dp"
            android:textSize="11sp"
            android:textStyle="bold"
            android:typeface="monospace" />
    </LinearLayout>

    <!-- ECU Module Switcher Tabs: Engine (0x01) vs Immobilizer (0x25) -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="8dp">

        <Button
            android:id="@+id/btnTabEngine"
            android:layout_width="0dp"
            android:layout_height="50dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ДВИГАТЕЛЬ (01)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#0284C7"
            android:textColor="#FFFFFF" />

        <Button
            android:id="@+id/btnTabImmo"
            android:layout_width="0dp"
            android:layout_height="50dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="ИММОБИЛАЙЗЕР (25)"
            android:textSize="12sp"
            android:textStyle="bold"
            android:backgroundTint="#334155"
            android:textColor="#94A3B8" />
    </LinearLayout>

    <!-- Status Card -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:background="#1E293B"
        android:padding="10dp"
        android:layout_marginBottom="8dp">

        <TextView
            android:id="@+id/tvStatus"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Статус: Ожидание подключения к ЭБУ"
            android:textColor="#FFFFFF"
            android:textSize="14sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/tvDeviceInfo"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Блок: Bosch Mono-Motronic 1.2.3 (3A0 907 311)"
            android:textColor="#38BDF8"
            android:textSize="12sp"
            android:layout_marginTop="2dp" />
    </LinearLayout>

    <!-- Live Gauges Dashboard (for Engine) -->
    <LinearLayout
        android:id="@+id/layoutLiveData"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:background="#0F172A"
        android:padding="8dp"
        android:layout_marginBottom="8dp">

        <!-- RPM -->
        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical"
            android:gravity="center">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="ОБОРОТЫ"
                android:textColor="#64748B"
                android:textSize="10sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/tvGaugeRpm"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="---"
                android:textColor="#38BDF8"
                android:textSize="17sp"
                android:textStyle="bold"
                android:typeface="monospace" />

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="об/мин"
                android:textColor="#94A3B8"
                android:textSize="10sp" />
        </LinearLayout>

        <!-- Coolant Temp -->
        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical"
            android:gravity="center">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="ДТОЖ G62"
                android:textColor="#64748B"
                android:textSize="10sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/tvGaugeTemp"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="---"
                android:textColor="#F59E0B"
                android:textSize="17sp"
                android:textStyle="bold"
                android:typeface="monospace" />

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="°C"
                android:textColor="#94A3B8"
                android:textSize="10sp" />
        </LinearLayout>

        <!-- Lambda O2 -->
        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical"
            android:gravity="center">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="ЛЯМБДА G39"
                android:textColor="#64748B"
                android:textSize="10sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/tvGaugeLambda"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="---"
                android:textColor="#10B981"
                android:textSize="17sp"
                android:textStyle="bold"
                android:typeface="monospace" />

            <TextView
                android:id="@+id/tvGaugeLambdaUnit"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Вольт"
                android:textColor="#94A3B8"
                android:textSize="10sp" />
        </LinearLayout>

        <!-- Throttle Angle / TPS -->
        <LinearLayout
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:orientation="vertical"
            android:gravity="center">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="ДПДЗ G69"
                android:textColor="#64748B"
                android:textSize="10sp"
                android:textStyle="bold" />

            <TextView
                android:id="@+id/tvGaugeThrottle"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="---"
                android:textColor="#EC4899"
                android:textSize="17sp"
                android:textStyle="bold"
                android:typeface="monospace" />

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="угол °"
                android:textColor="#94A3B8"
                android:textSize="10sp" />
        </LinearLayout>
    </LinearLayout>

    <!-- Immobilizer Status Card (visible when Immo tab selected) -->
    <LinearLayout
        android:id="@+id/layoutImmoStatus"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:background="#0F172A"
        android:padding="10dp"
        android:layout_marginBottom="8dp"
        android:visibility="gone">

        <TextView
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="СОСТОЯНИЕ ИММОБИЛАЙЗЕРА (1H0 953 257):"
            android:textColor="#38BDF8"
            android:textSize="12sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/tvImmoKeyStatus"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="• Транспондер ключа: Ожидание опроса..."
            android:textColor="#CBD5E1"
            android:textSize="12sp"
            android:layout_marginTop="3dp" />

        <TextView
            android:id="@+id/tvImmoStartStatus"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="• Разрешение пуска двигателя: Не проверено"
            android:textColor="#CBD5E1"
            android:textSize="12sp"
            android:layout_marginTop="2dp" />

        <TextView
            android:id="@+id/tvImmoKeyCount"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="• Ключей обучено в памяти: ---"
            android:textColor="#CBD5E1"
            android:textSize="12sp"
            android:layout_marginTop="2dp" />
    </LinearLayout>

    <!-- Actuator Test Controls Card (shows during actuator test) -->
    <LinearLayout
        android:id="@+id/layoutActuatorTest"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:background="#1E1B4B"
        android:padding="10dp"
        android:layout_marginBottom="8dp"
        android:visibility="gone">

        <TextView
            android:id="@+id/tvActuatorTitle"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="ТЕСТ ИСПОЛНИТЕЛЬНЫХ МЕХАНИЗМОВ (0x04)"
            android:textColor="#A78BFA"
            android:textSize="13sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/tvActuatorDesc"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Запуск теста..."
            android:textColor="#FFFFFF"
            android:textSize="12sp"
            android:layout_marginTop="4dp" />

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:layout_marginTop="8dp">

            <Button
                android:id="@+id/btnActuatorNext"
                android:layout_width="0dp"
                android:layout_height="52dp"
                android:layout_weight="1"
                android:layout_marginEnd="4dp"
                android:text="СЛЕДУЮЩИЙ ТЕСТ"
                android:textSize="13sp"
                android:textStyle="bold"
                android:backgroundTint="#7C3AED"
                android:textColor="#FFFFFF" />

            <Button
                android:id="@+id/btnActuatorStop"
                android:layout_width="0dp"
                android:layout_height="52dp"
                android:layout_weight="1"
                android:layout_marginStart="4dp"
                android:text="ЗАВЕРШИТЬ"
                android:textSize="13sp"
                android:textStyle="bold"
                android:backgroundTint="#EF4444"
                android:textColor="#FFFFFF" />
        </LinearLayout>
    </LinearLayout>

    <!-- Adaptation Controls Card (shows when Adaptation block is opened) -->
    <LinearLayout
        android:id="@+id/layoutAdaptation"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:background="#172554"
        android:padding="10dp"
        android:layout_marginBottom="8dp"
        android:visibility="gone">

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:gravity="center_vertical">

            <TextView
                android:layout_width="0dp"
                android:layout_height="wrap_content"
                android:layout_weight="1"
                android:text="АДАПТАЦИЯ БЛОКА (KWP1281)"
                android:textColor="#60A5FA"
                android:textSize="13sp"
                android:textStyle="bold" />

            <Button
                android:id="@+id/btnAdaptClose"
                android:layout_width="wrap_content"
                android:layout_height="36dp"
                android:text="Закрыть"
                android:textSize="11sp"
                android:backgroundTint="#1E293B"
                android:textColor="#94A3B8" />
        </LinearLayout>

        <TextView
            android:id="@+id/tvAdaptHint"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Канал 00: сброс выученных адаптаций / привязка ЭБУ"
            android:textColor="#CBD5E1"
            android:textSize="11sp"
            android:layout_marginTop="2dp"
            android:layout_marginBottom="6dp" />

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:gravity="center_vertical"
            android:layout_marginBottom="6dp">

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Канал:"
                android:textColor="#FFFFFF"
                android:textSize="12sp"
                android:textStyle="bold"
                android:layout_marginEnd="6dp" />

            <EditText
                android:id="@+id/etAdaptChannel"
                android:layout_width="64dp"
                android:layout_height="44dp"
                android:background="#0F172A"
                android:text="00"
                android:textColor="#38BDF8"
                android:textSize="15sp"
                android:textStyle="bold"
                android:gravity="center"
                android:inputType="number"
                android:maxLength="3"
                android:layout_marginEnd="12dp" />

            <TextView
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="Значение:"
                android:textColor="#FFFFFF"
                android:textSize="12sp"
                android:textStyle="bold"
                android:layout_marginEnd="6dp" />

            <EditText
                android:id="@+id/etAdaptValue"
                android:layout_width="0dp"
                android:layout_height="44dp"
                android:layout_weight="1"
                android:background="#0F172A"
                android:text="0"
                android:textColor="#10B981"
                android:textSize="15sp"
                android:textStyle="bold"
                android:gravity="center"
                android:inputType="number"
                android:maxLength="5" />
        </LinearLayout>

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal">

            <Button
                android:id="@+id/btnAdaptRead"
                android:layout_width="0dp"
                android:layout_height="48dp"
                android:layout_weight="1"
                android:layout_marginEnd="3dp"
                android:text="ЧИТАТЬ"
                android:textSize="12sp"
                android:textStyle="bold"
                android:backgroundTint="#0284C7"
                android:textColor="#FFFFFF" />

            <Button
                android:id="@+id/btnAdaptTest"
                android:layout_width="0dp"
                android:layout_height="48dp"
                android:layout_weight="1"
                android:layout_marginStart="3dp"
                android:layout_marginEnd="3dp"
                android:text="ТЕСТ"
                android:textSize="12sp"
                android:textStyle="bold"
                android:backgroundTint="#D97706"
                android:textColor="#FFFFFF" />

            <Button
                android:id="@+id/btnAdaptSave"
                android:layout_width="0dp"
                android:layout_height="48dp"
                android:layout_weight="1.2"
                android:layout_marginStart="3dp"
                android:text="СОХРАНИТЬ"
                android:textSize="12sp"
                android:textStyle="bold"
                android:backgroundTint="#10B981"
                android:textColor="#FFFFFF" />
        </LinearLayout>
    </LinearLayout>

    <!-- Main Action Buttons (Spacious 54dp/52dp buttons, full labels) -->
    <!-- Row 1: Full-width Connect button (auto-detects USB KKL) -->
    <Button
        android:id="@+id/btnConnectEcu"
        android:layout_width="match_parent"
        android:layout_height="54dp"
        android:layout_marginBottom="6dp"
        android:text="ПОДКЛЮЧИТЬ ЭБУ"
        android:textSize="15sp"
        android:textStyle="bold"
        android:backgroundTint="#10B981"
        android:textColor="#FFFFFF" />

    <!-- Row 2: DTC Faults -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="6dp">

        <Button
            android:id="@+id/btnReadFaults"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ОШИБКИ (07)"
            android:textSize="14sp"
            android:textStyle="bold"
            android:backgroundTint="#F59E0B"
            android:textColor="#FFFFFF"
            android:enabled="false" />

        <Button
            android:id="@+id/btnClearFaults"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="СТЕРЕТЬ (05)"
            android:textSize="14sp"
            android:textStyle="bold"
            android:backgroundTint="#EF4444"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <!-- Row 3: Live Data & Actuator Test -->
    <LinearLayout
        android:id="@+id/rowEngineDiagnostics"
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="6dp">

        <Button
            android:id="@+id/btnMeasuring"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ИЗМЕРЕНИЯ (08)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#8B5CF6"
            android:textColor="#FFFFFF"
            android:enabled="false" />

        <Button
            android:id="@+id/btnActuatorStart"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="ИСПОЛНИТЕЛИ (04)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#7C3AED"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <!-- Row 4: Basic Settings & Adaptation -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="6dp">

        <Button
            android:id="@+id/btnBasicSettings"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="БАЗОВЫЕ (УОЗ 6°)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#0D9488"
            android:textColor="#FFFFFF"
            android:enabled="false" />

        <Button
            android:id="@+id/btnAdaptationOpen"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="АДАПТАЦИЯ (10)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#2563EB"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <!-- Row 5: ECU Passport & Report -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="8dp">

        <Button
            android:id="@+id/btnEcuPassport"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ПАСПОРТ ЭБУ"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#475569"
            android:textColor="#FFFFFF"
            android:enabled="false" />

        <Button
            android:id="@+id/btnShareReport"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="КОПИРОВАТЬ ОТЧЁТ"
            android:textSize="12sp"
            android:textStyle="bold"
            android:backgroundTint="#1E293B"
            android:textColor="#38BDF8" />
    </LinearLayout>

    <!-- Diagnostic Results Display -->
    <ScrollView
        android:id="@+id/scrollViewResults"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:background="#020617"
        android:padding="10dp">

        <TextView
            android:id="@+id/tvResults"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:textColor="#F1F5F9"
            android:textSize="12sp"
            android:lineSpacingExtra="3dp"
            android:text="Подключите USB KKL адаптер к телефону, включите зажигание и нажмите «ПОДКЛЮЧИТЬ ЭБУ»." />
    </ScrollView>

</LinearLayout>
`
  },
  {
    path: 'app/src/main/java/com/vag/kw1281/MainActivity.kt',
    filename: 'MainActivity.kt',
    language: 'kotlin',
    description: 'Главный экран Android-приложения с фиксированной скоростью 9600 бод и защитой от сбоев',
    content: `package com.vag.kw1281

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.ColorStateList
import android.graphics.Color
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private var usbManager: UsbManager? = null
    private val ACTION_USB_PERMISSION = "com.vag.kw1281.USB_PERMISSION"

    // UI элементы статуса
    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceInfo: TextView
    private lateinit var tvBaudBadge: TextView
    private lateinit var tvResults: TextView
    private lateinit var scrollViewResults: ScrollView

    // Табы выбора ЭБУ
    private lateinit var btnTabEngine: Button
    private lateinit var btnTabImmo: Button
    private var selectedEcuAddress: Int = 0x01 // 0x01 = Двигатель, 0x25 = Иммобилайзер

    // Панели живых параметров (Engine)
    private lateinit var layoutLiveData: LinearLayout
    private lateinit var tvGaugeRpm: TextView
    private lateinit var tvGaugeTemp: TextView
    private lateinit var tvGaugeLambda: TextView
    private lateinit var tvGaugeLambdaUnit: TextView
    private lateinit var tvGaugeThrottle: TextView

    // Панель иммобилайзера (Immo)
    private lateinit var layoutImmoStatus: LinearLayout
    private lateinit var tvImmoKeyStatus: TextView
    private lateinit var tvImmoStartStatus: TextView
    private lateinit var tvImmoKeyCount: TextView

    // Панель теста исполнителей (0x04)
    private lateinit var layoutActuatorTest: LinearLayout
    private lateinit var tvActuatorTitle: TextView
    private lateinit var tvActuatorDesc: TextView
    private lateinit var btnActuatorNext: Button
    private lateinit var btnActuatorStop: Button

    // Панель адаптации (0x21 / 0x22 / 0x2A)
    private lateinit var layoutAdaptation: LinearLayout
    private lateinit var tvAdaptHint: TextView
    private lateinit var etAdaptChannel: EditText
    private lateinit var etAdaptValue: EditText
    private lateinit var btnAdaptRead: Button
    private lateinit var btnAdaptTest: Button
    private lateinit var btnAdaptSave: Button
    private lateinit var btnAdaptClose: Button

    // Основные кнопки управления (без "ПОИСК KKL")
    private lateinit var rowEngineDiagnostics: LinearLayout
    private lateinit var btnConnectEcu: Button
    private lateinit var btnReadFaults: Button
    private lateinit var btnClearFaults: Button
    private lateinit var btnMeasuring: Button
    private lateinit var btnActuatorStart: Button
    private lateinit var btnBasicSettings: Button
    private lateinit var btnAdaptationOpen: Button
    private lateinit var btnEcuPassport: Button
    private lateinit var btnShareReport: Button

    // Связь и фоновые потоки
    private var foundDevice: UsbDevice? = null
    private var kwDriver: Ftdi5BaudDriver? = null
    private var kwProtocol: Kw1281Protocol? = null
    private var isReceiverRegistered = false
    private var pendingConnectAfterPermission = false
    private var liveStreamJob: Job? = null
    private var basicSettingsJob: Job? = null

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    val shouldConnect = pendingConnectAfterPermission
                    pendingConnectAfterPermission = false

                    if (granted) {
                        findUsbAdapter(autoRequestPermission = false)
                        if (shouldConnect) {
                            connectToSelectedEcu()
                        } else {
                            setResultText("Разрешение на USB адаптер получено. Нажмите «ПОДКЛЮЧИТЬ ЭБУ».")
                        }
                    } else {
                        setResultText("Разрешение USB отклонено. Нажмите «ПОДКЛЮЧИТЬ ЭБУ» и подтвердите доступ к адаптеру.")
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    findUsbAdapter(autoRequestPermission = true)
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val currentList = usbManager?.deviceList
                    val stillPresent = currentList?.values?.any { isSupportedAdapter(it) } == true
                    if (!stillPresent) {
                        disconnectSession()
                        foundDevice = null
                        updateConnectButtonState(connected = false)
                        setDiagnosticButtonsEnabled(false)
                        tvStatus.text = "Статус: USB-адаптер отключён"
                        tvDeviceInfo.text = "Подключите USB-OTG KKL кабель"
                        setResultText("USB KKL адаптер отключён от смартфона.")
                    } else {
                        findUsbAdapter(autoRequestPermission = false)
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            setContentView(R.layout.activity_main)

            usbManager = getSystemService(Context.USB_SERVICE) as? UsbManager

            // Привязка UI
            tvStatus = findViewById(R.id.tvStatus)
            tvDeviceInfo = findViewById(R.id.tvDeviceInfo)
            tvBaudBadge = findViewById(R.id.tvBaudBadge)
            tvResults = findViewById(R.id.tvResults)
            scrollViewResults = findViewById(R.id.scrollViewResults)

            btnTabEngine = findViewById(R.id.btnTabEngine)
            btnTabImmo = findViewById(R.id.btnTabImmo)

            layoutLiveData = findViewById(R.id.layoutLiveData)
            tvGaugeRpm = findViewById(R.id.tvGaugeRpm)
            tvGaugeTemp = findViewById(R.id.tvGaugeTemp)
            tvGaugeLambda = findViewById(R.id.tvGaugeLambda)
            tvGaugeLambdaUnit = findViewById(R.id.tvGaugeLambdaUnit)
            tvGaugeThrottle = findViewById(R.id.tvGaugeThrottle)

            layoutImmoStatus = findViewById(R.id.layoutImmoStatus)
            tvImmoKeyStatus = findViewById(R.id.tvImmoKeyStatus)
            tvImmoStartStatus = findViewById(R.id.tvImmoStartStatus)
            tvImmoKeyCount = findViewById(R.id.tvImmoKeyCount)

            layoutActuatorTest = findViewById(R.id.layoutActuatorTest)
            tvActuatorTitle = findViewById(R.id.tvActuatorTitle)
            tvActuatorDesc = findViewById(R.id.tvActuatorDesc)
            btnActuatorNext = findViewById(R.id.btnActuatorNext)
            btnActuatorStop = findViewById(R.id.btnActuatorStop)

            layoutAdaptation = findViewById(R.id.layoutAdaptation)
            tvAdaptHint = findViewById(R.id.tvAdaptHint)
            etAdaptChannel = findViewById(R.id.etAdaptChannel)
            etAdaptValue = findViewById(R.id.etAdaptValue)
            btnAdaptRead = findViewById(R.id.btnAdaptRead)
            btnAdaptTest = findViewById(R.id.btnAdaptTest)
            btnAdaptSave = findViewById(R.id.btnAdaptSave)
            btnAdaptClose = findViewById(R.id.btnAdaptClose)

            rowEngineDiagnostics = findViewById(R.id.rowEngineDiagnostics)
            btnConnectEcu = findViewById(R.id.btnConnectEcu)
            btnReadFaults = findViewById(R.id.btnReadFaults)
            btnClearFaults = findViewById(R.id.btnClearFaults)
            btnMeasuring = findViewById(R.id.btnMeasuring)
            btnActuatorStart = findViewById(R.id.btnActuatorStart)
            btnBasicSettings = findViewById(R.id.btnBasicSettings)
            btnAdaptationOpen = findViewById(R.id.btnAdaptationOpen)
            btnEcuPassport = findViewById(R.id.btnEcuPassport)
            btnShareReport = findViewById(R.id.btnShareReport)

            // Переключение табов ЭБУ
            btnTabEngine.setOnClickListener { switchEcuTab(0x01) }
            btnTabImmo.setOnClickListener { switchEcuTab(0x25) }

            // Обработчики кнопок
            btnConnectEcu.setOnClickListener { onConnectButtonClicked() }
            btnReadFaults.setOnClickListener { readFaultCodes() }
            btnClearFaults.setOnClickListener { clearFaultCodes() }
            btnMeasuring.setOnClickListener { toggleLiveMeasuring() }
            btnActuatorStart.setOnClickListener { startActuatorTest() }
            btnActuatorNext.setOnClickListener { nextActuatorTest() }
            btnActuatorStop.setOnClickListener { stopActuatorTest() }
            btnBasicSettings.setOnClickListener { toggleBasicSettings() }
            btnAdaptationOpen.setOnClickListener { toggleAdaptationPanel() }
            btnAdaptClose.setOnClickListener { layoutAdaptation.visibility = View.GONE }
            btnAdaptRead.setOnClickListener { performAdaptationRead() }
            btnAdaptTest.setOnClickListener { performAdaptationTest() }
            btnAdaptSave.setOnClickListener { performAdaptationSave() }
            btnEcuPassport.setOnClickListener { showEcuPassport() }
            btnShareReport.setOnClickListener { copyDiagnosticReport() }

            val filter = IntentFilter().apply {
                addAction(ACTION_USB_PERMISSION)
                addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
                addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(usbReceiver, filter, Context.RECEIVER_EXPORTED)
            } else {
                registerReceiver(usbReceiver, filter)
            }
            isReceiverRegistered = true

            switchEcuTab(0x01)
            updateConnectButtonState(connected = false)
            findUsbAdapter(autoRequestPermission = true)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onResume() {
        super.onResume()
        if (kwProtocol?.isSessionActive != true) {
            findUsbAdapter(autoRequestPermission = false)
        }
    }

    private fun isSupportedAdapter(dev: UsbDevice): Boolean {
        return dev.vendorId == 0x0403 || dev.vendorId == 0x1A86 || dev.vendorId == 0x10C4
    }

    private fun switchEcuTab(addr: Int) {
        if (selectedEcuAddress != addr) {
            disconnectSession()
            setDiagnosticButtonsEnabled(false)
            updateConnectButtonState(connected = false)
        }
        selectedEcuAddress = addr
        resetGauges()

        if (addr == 0x01) {
            btnTabEngine.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0284C7"))
            btnTabEngine.setTextColor(Color.WHITE)
            btnTabImmo.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#334155"))
            btnTabImmo.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Bosch Mono-Motronic 1.2.3 (3A0 907 311)"
            layoutLiveData.visibility = View.VISIBLE
            layoutImmoStatus.visibility = View.GONE
            rowEngineDiagnostics.visibility = View.VISIBLE
            btnBasicSettings.visibility = View.VISIBLE
            btnAdaptationOpen.visibility = View.VISIBLE
            tvAdaptHint.text = "Канал 00: сброс выученных адаптаций смеси/РХХ (Сохранить 0)"
        } else {
            btnTabImmo.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0284C7"))
            btnTabImmo.setTextColor(Color.WHITE)
            btnTabEngine.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#334155"))
            btnTabEngine.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Иммобилайзер Wegfahrsicherung (1H0 953 257)"
            layoutLiveData.visibility = View.GONE
            layoutImmoStatus.visibility = View.VISIBLE
            rowEngineDiagnostics.visibility = View.GONE
            btnBasicSettings.visibility = View.GONE
            btnAdaptationOpen.visibility = View.VISIBLE
            tvAdaptHint.text = "Канал 00: привязка ЭБУ к иммобилайзеру (Сохранить 0) • Канал 01: кол-во ключей"
        }
    }

    private fun resetGauges() {
        tvGaugeRpm.text = "---"
        tvGaugeTemp.text = "---"
        tvGaugeLambda.text = "---"
        tvGaugeLambdaUnit.text = "Вольт"
        tvGaugeThrottle.text = "---"
    }

    private fun setResultText(msg: String) {
        runOnUiThread {
            try {
                tvResults.text = msg
                scrollViewResults.post {
                    scrollViewResults.fullScroll(ScrollView.FOCUS_UP)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun updateConnectButtonState(connected: Boolean) {
        runOnUiThread {
            if (connected) {
                btnConnectEcu.text = "ОТКЛЮЧИТЬ СЕАНС"
                btnConnectEcu.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#475569"))
            } else {
                btnConnectEcu.text = "ПОДКЛЮЧИТЬ ЭБУ"
                btnConnectEcu.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#10B981"))
            }
        }
    }

    private fun setDiagnosticButtonsEnabled(enabled: Boolean) {
        btnReadFaults.isEnabled = enabled
        btnClearFaults.isEnabled = enabled
        btnMeasuring.isEnabled = enabled
        btnActuatorStart.isEnabled = enabled
        btnBasicSettings.isEnabled = enabled
        btnAdaptationOpen.isEnabled = enabled
        btnEcuPassport.isEnabled = enabled
    }

    private fun findUsbAdapter(autoRequestPermission: Boolean): UsbDevice? {
        val manager = usbManager ?: return null
        val deviceList = manager.deviceList
        val ftdi = deviceList.values.firstOrNull { it.vendorId == 0x0403 }
            ?: deviceList.values.firstOrNull { it.vendorId == 0x1A86 || it.vendorId == 0x10C4 }

        foundDevice = ftdi
        if (ftdi != null) {
            if (kwProtocol?.isSessionActive != true) {
                tvStatus.text = "Статус: Адаптер KKL готов (VID 0x%04X)".format(ftdi.vendorId)
            }
            if (!manager.hasPermission(ftdi) && autoRequestPermission) {
                requestUsbPermission(ftdi)
            }
        } else {
            if (kwProtocol?.isSessionActive != true) {
                tvStatus.text = "Статус: Подключите USB KKL кабель"
            }
        }
        return ftdi
    }

    private fun requestUsbPermission(device: UsbDevice) {
        val manager = usbManager ?: return
        try {
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE
            } else {
                0
            }
            val permissionIntent = PendingIntent.getBroadcast(
                this, 0, Intent(ACTION_USB_PERMISSION), flags
            )
            manager.requestPermission(device, permissionIntent)
        } catch (e: Exception) {}
    }

    private fun onConnectButtonClicked() {
        if (kwProtocol?.isSessionActive == true) {
            disconnectSession()
            setDiagnosticButtonsEnabled(false)
            updateConnectButtonState(connected = false)
            tvStatus.text = "Статус: Сеанс завершён"
            setResultText("Диагностический сеанс с блоком закрыт.")
            return
        }
        connectToSelectedEcu()
    }

    private fun disconnectSession() {
        stopAllBackgroundLoops()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = View.GONE
        try {
            kwProtocol?.stopSession()
        } catch (t: Throwable) {}
        try {
            kwDriver?.close()
        } catch (t: Throwable) {}
        kwProtocol = null
        kwDriver = null
    }

    private fun stopAllBackgroundLoops() {
        stopLiveStream()
        stopBasicSettingsStream()
    }

    private fun connectToSelectedEcu() {
        val manager = usbManager ?: return
        val dev = findUsbAdapter(autoRequestPermission = false)
        if (dev == null) {
            setResultText("USB KKL адаптер не обнаружен.\\n\\n• Подключите кабель через USB-OTG переходник к телефону.\\n• На некоторых смартфонах нужно включить «OTG-подключение» в настройках системы.")
            return
        }

        if (!manager.hasPermission(dev)) {
            pendingConnectAfterPermission = true
            setResultText("Запрос системного разрешения Android на доступ к USB адаптеру...")
            requestUsbPermission(dev)
            return
        }

        lifecycleScope.launch {
            try {
                stopAllBackgroundLoops()
                layoutActuatorTest.visibility = View.GONE
                layoutAdaptation.visibility = View.GONE
                btnConnectEcu.isEnabled = false
                setDiagnosticButtonsEnabled(false)
                resetGauges()

                val blockName = if (selectedEcuAddress == 0x25) "Иммобилайзера (0x25)" else "ЭБУ Двигателя (0x01)"
                tvStatus.text = "Инициализация $blockName..."
                setResultText("Установка связи с $blockName (5 бод -> 9600 бод)...")

                disconnectSession()
                val newDriver = Ftdi5BaudDriver(manager, dev)
                if (!newDriver.open(9600)) {
                    tvStatus.text = "Ошибка открытия USB порта"
                    setResultText("Не удалось открыть USB порт: \${newDriver.lastError ?: "проверьте кабель"}")
                    btnConnectEcu.isEnabled = true
                    updateConnectButtonState(connected = false)
                    return@launch
                }
                kwDriver = newDriver

                val protocol = Kw1281Protocol(newDriver)
                kwProtocol = protocol
                val success = protocol.connect(selectedEcuAddress) { }

                if (success) {
                    val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else (if (selectedEcuAddress == 0x25) "1H0 953 257" else "3A0 907 311")
                    tvStatus.text = "Подключен: $pNum"
                    tvBaudBadge.text = "\${protocol.negotiatedBaud} бод"
                    btnConnectEcu.isEnabled = true
                    updateConnectButtonState(connected = true)
                    setDiagnosticButtonsEnabled(true)

                    if (selectedEcuAddress == 0x25) {
                        checkImmobilizerStatus(protocol)
                    } else {
                        setResultText("Связь с ЭБУ Двигателя установлена!\\n" +
                                "• Номер VAG: \${protocol.ecuPartNumber}\\n" +
                                "• Компонент: \${protocol.ecuComponent}\\n" +
                                "• Кодировка: \${protocol.ecuExtra}\\n\\n" +
                                "Доступны: Ошибки (07), Измерения (08), Тест исполнителей (04), Базовые (УОЗ 6°) и Адаптация (10).")
                    }
                } else {
                    disconnectSession()
                    tvStatus.text = "Нет ответа от блока"
                    setResultText("Блок $blockName не отвечает на запрос инициализации.\\n" +
                            "• Проверьте, включено ли зажигание (приборная панель горит).\\n" +
                            "• Проверьте питание +12В на KKL адаптере (горит светодиод на шнурке) и контакт K-Line.")
                    btnConnectEcu.isEnabled = true
                    updateConnectButtonState(connected = false)
                }
            } catch (t: Throwable) {
                t.printStackTrace()
                disconnectSession()
                tvStatus.text = "Сбой подключения"
                setResultText("Сбой при подключении: \${t.message ?: t.javaClass.simpleName}")
                btnConnectEcu.isEnabled = true
                updateConnectButtonState(connected = false)
            }
        }
    }

    private suspend fun checkImmobilizerStatus(protocol: Kw1281Protocol) {
        val status = protocol.readImmobilizerStatus { }
        if (status != null) {
            tvImmoKeyStatus.text = "• Транспондер ключа: \${if (status.keyAuthorized) "✅ Распознан (ID33 OK)" else "❌ ОШИБКА (Чип не прочитан)"}"
            tvImmoStartStatus.text = "• Разрешение пуска двигателя: \${if (status.startPermitted) "✅ РАЗРЕШЁН" else "❌ ЗАБЛОКИРОВАН (заглохнет через 1 сек)"}"
            tvImmoKeyCount.text = "• Ключей обучено в памяти: \${status.keyCount} шт."

            setResultText("Блок иммобилайзера 1H0 953 257 подключен!\\n\\n" +
                    "ДИАГНОСТИКА КЛЮЧА И СИСТЕМЫ ПУСКА:\\n" +
                    "• Разрешение запуска: \${if (status.startPermitted) "РАЗРЕШЕНО (ЭБУ не блокируется)" else "ЗАПРЕЩЕНО (Блокировка мотора)"}\\n" +
                    "• Ответ ЭБУ двигателя: \${if (status.ecuResponds) "Есть связь по W-Line" else "Нет связи с моторным ЭБУ"}\\n" +
                    "• Транспондер чипа: \${if (status.keyAuthorized) "Авторизован" else "Не авторизован / Слабый сигнал катушки"}\\n" +
                    "• Ключей прописано: \${status.keyCount}\\n\\n" +
                    "Для синхронизации ЭБУ с иммобилайзером откройте «АДАПТАЦИЯ (10)» → Канал 00 → «СОХРАНИТЬ» (значение 0).")
        } else {
            setResultText("Иммобилайзер подключен. Номер блока: \${protocol.ecuPartNumber}\\n" +
                    "Вы можете прочитать ошибки (07) или открыть Адаптацию (10).")
        }
    }

    private fun readFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopAllBackgroundLoops()
                layoutActuatorTest.visibility = View.GONE
                btnReadFaults.isEnabled = false
                val faults = protocol.readFaultCodesDetailed { }
                btnReadFaults.isEnabled = true

                val sb = StringBuilder()
                val blockTitle = if (selectedEcuAddress == 0x25) "ИММОБИЛАЙЗЕР (1H0 953 257)" else "ЭБУ ДВИГАТЕЛЯ (Mono-Motronic)"
                sb.append("РЕЗУЛЬТАТЫ ОПРОСА ПАМЯТИ НЕИСПРАВНОСТЕЙ:\\n")
                sb.append("Блок: ").append(blockTitle).append("\\n\\n")

                if (faults.isEmpty()) {
                    sb.append("✅ В памяти ошибок нет (DTC 00000).\\n")
                    sb.append("Все электрические цепи и датчики в пределах нормы.")
                } else {
                    sb.append("⚠️ ОБНАРУЖЕНО НЕИСПРАВНОСТЕЙ: ").append(faults.size).append("\\n\\n")
                    for (f in faults) {
                        sb.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n")
                        sb.append("КОД: ").append(f.code).append(" — ").append(f.component).append("\\n")
                        sb.append("Статус: ").append(f.statusText).append("\\n")
                        sb.append("Причина: ").append(f.cause).append("\\n")
                        sb.append("Совет: ").append(f.remedy).append("\\n")
                        if (f.isNormalWhenStopped) {
                            sb.append("ℹ️ ПРИМЕЧАНИЕ: На незаведённом моторе эта ошибка является нормой для Mono-Motronic 1.2.3!\\n")
                        }
                    }
                    sb.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\\n")
                }
                setResultText(sb.toString())
            } catch (t: Throwable) {
                btnReadFaults.isEnabled = true
                setResultText("Ошибка чтения памяти неисправностей: \${t.message}")
            }
        }
    }

    private fun clearFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopAllBackgroundLoops()
                layoutActuatorTest.visibility = View.GONE
                btnClearFaults.isEnabled = false
                val success = protocol.clearFaultCodes { }
                btnClearFaults.isEnabled = true
                if (success) {
                    setResultText("✅ Память кодов неисправностей успешно очищена!\\n" +
                            "Нажмите «ОШИБКИ (07)» для контрольной проверки.")
                } else {
                    setResultText("Не удалось выполнить команду стирания ошибок.")
                }
            } catch (t: Throwable) {
                btnClearFaults.isEnabled = true
                setResultText("Ошибка стирания ошибок: \${t.message}")
            }
        }
    }

    private fun toggleLiveMeasuring() {
        if (liveStreamJob != null) {
            stopLiveStream()
            setResultText("Поток живых измерений остановлен.")
            return
        }

        val protocol = kwProtocol ?: run {
            setResultText("Сначала подключитесь к ЭБУ.")
            return
        }

        stopBasicSettingsStream()
        layoutActuatorTest.visibility = View.GONE
        btnMeasuring.text = "СТОП (08)"
        btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DC2626"))
        setResultText("Опрос живых параметров датчиков (Группы 001 и 003 / 000)...")

        liveStreamJob = lifecycleScope.launch {
            var useGroupZeroOnly = false
            var checkGroup5ForLambda = false
            var consecutiveErrors = 0
            var cycleCount = 0

            var lastRpm: Int? = null
            var lastTemp: Int? = null
            var lastLambdaV: Double? = null
            var lastLambdaCorr: Double? = null
            var lastThrottle: Double? = null
            var lastAirTemp: Int? = null
            var lastBatteryV: Double? = null
            var lastInjMs: Double? = null

            try {
                while (isActive && protocol.isSessionActive) {
                    var gotValid = false
                    var lastErr: String? = null
                    var g1Fields = emptyList<Kw1281Protocol.MeasuredField>()
                    var g3Fields = emptyList<Kw1281Protocol.MeasuredField>()
                    var g0Raw = emptyList<Int>()

                    if (!useGroupZeroOnly) {
                        val m1 = protocol.readMeasuringGroup(1) { }
                        if (m1 != null) {
                            if (m1.isUnsupportedNak) {
                                useGroupZeroOnly = true
                            } else if (m1.errorMessage == null && (m1.fields.isNotEmpty() || m1.rpm != null)) {
                                gotValid = true
                                m1.rpm?.let { lastRpm = it }
                                m1.coolantTemp?.let { lastTemp = it }
                                m1.lambdaVoltage?.let { lastLambdaV = it }
                                m1.lambdaCorrection?.let { lastLambdaCorr = it }
                                g1Fields = m1.fields
                                if (cycleCount == 0 && m1.lambdaVoltage == null) {
                                    checkGroup5ForLambda = true
                                }
                            } else {
                                lastErr = m1.errorMessage
                            }
                        }

                        if (!useGroupZeroOnly && isActive && protocol.isSessionActive) {
                            delay(60)
                            val m3 = protocol.readMeasuringGroup(3) { }
                            if (m3 != null && !m3.isUnsupportedNak && m3.errorMessage == null) {
                                gotValid = true
                                m3.rpm?.let { if (lastRpm == null) lastRpm = it }
                                m3.throttleAngle?.let { lastThrottle = it }
                                m3.intakeAirTemp?.let { lastAirTemp = it }
                                g3Fields = m3.fields
                            }
                        }

                        if (!useGroupZeroOnly && checkGroup5ForLambda && cycleCount % 2 == 0 && isActive && protocol.isSessionActive) {
                            delay(60)
                            val m5 = protocol.readMeasuringGroup(5) { }
                            if (m5 != null && !m5.isUnsupportedNak && m5.errorMessage == null) {
                                m5.lambdaVoltage?.let { lastLambdaV = it }
                                m5.lambdaCorrection?.let { if (lastLambdaCorr == null) lastLambdaCorr = it }
                            } else if (m5?.isUnsupportedNak == true) {
                                checkGroup5ForLambda = false
                            }
                        }

                        if (!useGroupZeroOnly && cycleCount % 4 == 0 && isActive && protocol.isSessionActive) {
                            delay(60)
                            val m2 = protocol.readMeasuringGroup(2) { }
                            if (m2 != null && !m2.isUnsupportedNak && m2.errorMessage == null) {
                                m2.batteryVoltage?.let { lastBatteryV = it }
                                m2.injectionTimeMs?.let { lastInjMs = it }
                                m2.intakeAirTemp?.let { lastAirTemp = it }
                            }
                        }
                    }

                    if (useGroupZeroOnly && isActive && protocol.isSessionActive) {
                        val m0 = protocol.readMeasuringGroup(0) { }
                        if (m0 != null && m0.errorMessage == null && (m0.rawValues.isNotEmpty() || m0.fields.isNotEmpty())) {
                            gotValid = true
                            m0.rpm?.let { lastRpm = it }
                            m0.coolantTemp?.let { lastTemp = it }
                            m0.lambdaVoltage?.let { lastLambdaV = it }
                            m0.throttleAngle?.let { lastThrottle = it }
                            m0.batteryVoltage?.let { lastBatteryV = it }
                            g0Raw = m0.rawValues
                        } else if (m0 != null) {
                            lastErr = m0.errorMessage
                        }
                    }

                    if (gotValid) {
                        consecutiveErrors = 0
                        updateGaugeViews(lastRpm, lastTemp, lastLambdaV, lastLambdaCorr, lastThrottle)

                        val sb = StringBuilder()
                        sb.append(if (useGroupZeroOnly) "ЖИВЫЕ ПАРАМЕТРЫ (ГРУППА 000):\\n" else "ЖИВЫЕ ПАРАМЕТРЫ ДАТЧИКОВ (ГРУППЫ 001 / 003):\\n")
                        sb.append("• Обороты (G40): ").append(lastRpm?.let { "$it об/мин" } ?: "---").append("\\n")
                        sb.append("• ДТОЖ (G62): ").append(lastTemp?.let { "$it °C" } ?: "---").append("\\n")
                        val lambdaText = when {
                            lastLambdaV != null -> "%.2f В".format(lastLambdaV)
                            lastLambdaCorr != null -> "%.1f %% (коррекция)".format(lastLambdaCorr)
                            else -> "---"
                        }
                        sb.append("• Лямбда-зонд (G39): ").append(lambdaText).append("\\n")
                        sb.append("• ДПДЗ угол (G69): ").append(lastThrottle?.let { "%.1f °".format(it) } ?: "---").append("\\n")
                        lastBatteryV?.let { sb.append("• Напряжение АКБ: %.2f В\\n".format(it)) }
                        lastInjMs?.let { sb.append("• Время впрыска: %.2f мс\\n".format(it)) }
                        lastAirTemp?.let { sb.append("• ДТВВ (G42): $it °C\\n") }

                        if (g1Fields.isNotEmpty()) {
                            sb.append("\\nГруппа 001: ").append(g1Fields.joinToString(" | ") { it.valueText })
                        }
                        if (g3Fields.isNotEmpty()) {
                            sb.append("\\nГруппа 003: ").append(g3Fields.joinToString(" | ") { it.valueText })
                        }
                        if (g0Raw.isNotEmpty()) {
                            sb.append("\\nБайты 000: ").append(g0Raw.joinToString(" ") { "%03d".format(it) })
                        }
                        setResultText(sb.toString())
                    } else {
                        consecutiveErrors++
                        if (consecutiveErrors >= 3) {
                            setResultText("⚠️ Нет данных от ЭБУ при чтении измерений.\\nПричина: \${lastErr ?: "ЭБУ не отвечает"}.\\nПроверьте зажигание и соединение K-Line.")
                        }
                    }

                    cycleCount++
                    delay(200)
                }
            } catch (t: Throwable) {
                // Корректное завершение при отмене job
            } finally {
                liveStreamJob = null
                runOnUiThread {
                    btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
                    btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#8B5CF6"))
                }
            }
        }
    }

    private fun stopLiveStream() {
        liveStreamJob?.cancel()
        liveStreamJob = null
        runOnUiThread {
            btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
            btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#8B5CF6"))
        }
    }

    private fun updateGaugeViews(
        rpm: Int?,
        temp: Int?,
        lambdaV: Double?,
        lambdaCorr: Double?,
        throttle: Double?
    ) {
        runOnUiThread {
            rpm?.let { tvGaugeRpm.text = "$it" }
            temp?.let { tvGaugeTemp.text = "$it" }
            if (lambdaV != null) {
                tvGaugeLambda.text = "%.2f".format(lambdaV)
                tvGaugeLambdaUnit.text = "Вольт"
            } else if (lambdaCorr != null) {
                tvGaugeLambda.text = "%.1f".format(lambdaCorr)
                tvGaugeLambdaUnit.text = "% корр."
            }
            throttle?.let { tvGaugeThrottle.text = "%.1f".format(it) }
        }
    }

    // Тест исполнительных механизмов (0x04)
    private fun startActuatorTest() {
        if (kwProtocol == null) return
        stopAllBackgroundLoops()
        layoutAdaptation.visibility = View.GONE
        layoutActuatorTest.visibility = View.VISIBLE
        tvActuatorTitle.text = "ТЕСТ ИСПОЛНИТЕЛЬНЫХ МЕХАНИЗМОВ (0x04)"
        tvActuatorDesc.text = "Запуск первого теста..."
        nextActuatorTest()
    }

    private fun nextActuatorTest() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                btnActuatorNext.isEnabled = false
                val res = protocol.stepActuatorTest { }
                btnActuatorNext.isEnabled = true

                if (res.active && !res.finished) {
                    tvActuatorDesc.text = res.text
                    setResultText("АКТИВЕН ТЕСТ ИСПОЛНИТЕЛЕЙ (0x04):\\n\\n\${res.text}\\n\\n" +
                            "Для перехода к следующему механизму нажмите «СЛЕДУЮЩИЙ ТЕСТ».")
                } else {
                    layoutActuatorTest.visibility = View.GONE
                    setResultText(res.text)
                }
            } catch (t: Throwable) {
                btnActuatorNext.isEnabled = true
                layoutActuatorTest.visibility = View.GONE
                setResultText("Ошибка шага теста исполнителей: \${t.message}")
            }
        }
    }

    private fun stopActuatorTest() {
        val protocol = kwProtocol
        lifecycleScope.launch {
            btnActuatorNext.isEnabled = false
            btnActuatorStop.isEnabled = false
            try {
                protocol?.finishActuatorTest()
            } catch (t: Throwable) {}
            btnActuatorNext.isEnabled = true
            btnActuatorStop.isEnabled = true
            layoutActuatorTest.visibility = View.GONE
            setResultText("Тест исполнительных механизмов завершён.")
        }
    }

    // Базовые установки (0x28 / 0x11)
    private fun toggleBasicSettings() {
        if (basicSettingsJob != null) {
            stopBasicSettingsStream()
            setResultText("Режим базовых установок завершён.")
            return
        }

        val protocol = kwProtocol ?: return
        stopLiveStream()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = View.GONE

        btnBasicSettings.text = "СТОП БАЗОВЫЕ"
        btnBasicSettings.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DC2626"))
        setResultText("Вход в режим базовых установок (0x28 / 0x11)...")

        basicSettingsJob = lifecycleScope.launch {
            var activeGroup = 0
            try {
                var firstResult = protocol.enterBasicSettings(0) { }
                if (!firstResult.success && firstResult.message.contains("NAK")) {
                    val fallbackGroup1 = protocol.enterBasicSettings(1) { }
                    if (fallbackGroup1.success) {
                        activeGroup = 1
                        firstResult = fallbackGroup1
                    }
                }

                if (!firstResult.success) {
                    setResultText("❌ Не удалось войти в Базовые установки:\\n\${firstResult.message}")
                    return@launch
                }

                while (isActive && protocol.isSessionActive) {
                    val res = if (firstResult != null) {
                        val tmp = firstResult
                        firstResult = null
                        tmp
                    } else {
                        protocol.enterBasicSettings(activeGroup) { }
                    }

                    if (!res.success) {
                        setResultText("Базовые установки прерваны: \${res.message}")
                        break
                    }

                    val m = res.measurement
                    if (m != null) {
                        updateGaugeViews(m.rpm, m.coolantTemp, m.lambdaVoltage, m.lambdaCorrection, m.throttleAngle)
                    }

                    val extraLine = when {
                        m != null && m.rawValues.isNotEmpty() && m.rawValues.size == 10 ->
                            "Байты 000: \${m.rawValues.joinToString(" ") { "%03d".format(it) }}"
                        m != null && m.fields.isNotEmpty() ->
                            "Параметры: \${m.fields.joinToString(" | ") { it.valueText }}"
                        else -> res.message
                    }

                    setResultText("🔧 РЕЖИМ БАЗОВЫХ УСТАНОВОК (Группа %03d) АКТИВЕН!\\n\\n".format(activeGroup) +
                            "• ЭБУ зафиксировал базовый угол опережения зажигания.\\n" +
                            "• Для регулировки УОЗ 6° до ВМТ проверьте прогрев (>80°C) и работайте стробоскопом по метке маховика.\\n" +
                            "• $extraLine\\n\\n" +
                            "Нажмите «СТОП БАЗОВЫЕ» для выхода из режима.")

                    delay(450)
                }
            } catch (t: Throwable) {
                // Остановка по отмене
            } finally {
                basicSettingsJob = null
                runOnUiThread {
                    btnBasicSettings.text = "БАЗОВЫЕ (УОЗ 6°)"
                    btnBasicSettings.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0D9488"))
                }
            }
        }
    }

    private fun stopBasicSettingsStream() {
        basicSettingsJob?.cancel()
        basicSettingsJob = null
        runOnUiThread {
            btnBasicSettings.text = "БАЗОВЫЕ (УОЗ 6°)"
            btnBasicSettings.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0D9488"))
        }
    }

    // Блок Адаптации (0x21 / 0x22 / 0x2A)
    private fun toggleAdaptationPanel() {
        stopAllBackgroundLoops()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = if (layoutAdaptation.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    private fun parseAdaptInputs(needValue: Boolean): Pair<Int, Int>? {
        val ch = etAdaptChannel.text.toString().trim().toIntOrNull()
        if (ch == null || ch !in 0..255) {
            setResultText("Ошибка ввода: номер канала должен быть числом от 0 до 255.")
            return null
        }
        val valNum = if (needValue) {
            val v = etAdaptValue.text.toString().trim().toIntOrNull()
            if (v == null || v !in 0..65535) {
                setResultText("Ошибка ввода: значение адаптации должно быть от 0 до 65535.")
                return null
            }
            v
        } else {
            0
        }
        return ch to valNum
    }

    private fun setAdaptationButtonsEnabled(enabled: Boolean) {
        btnAdaptRead.isEnabled = enabled
        btnAdaptTest.isEnabled = enabled
        btnAdaptSave.isEnabled = enabled
    }

    private fun performAdaptationRead() {
        val protocol = kwProtocol ?: return
        val inputs = parseAdaptInputs(needValue = false) ?: return
        val channel = inputs.first

        lifecycleScope.launch {
            stopAllBackgroundLoops()
            setAdaptationButtonsEnabled(false)
            val res = protocol.readAdaptation(channel)
            setAdaptationButtonsEnabled(true)

            if (res.success) {
                etAdaptValue.setText(res.value.toString())
                setResultText("✅ \${res.message}\\n\\n" +
                        "Текущее сохранённое значение канала %02d загружено в поле «Значение».".format(res.channel))
            } else {
                val tip = if (channel == 0) {
                    "\\n\\nℹ️ Подсказка: На многих блоках Mono-Motronic и Иммо канал 00 не поддерживает чтение — для сброса адаптаций / привязки ЭБУ введите значение 0 и сразу нажмите «СОХРАНИТЬ»."
                } else ""
                setResultText("⚠️ \${res.message}$tip")
            }
        }
    }

    private fun performAdaptationTest() {
        val protocol = kwProtocol ?: return
        val (channel, value) = parseAdaptInputs(needValue = true) ?: return

        lifecycleScope.launch {
            stopAllBackgroundLoops()
            setAdaptationButtonsEnabled(false)
            val res = protocol.testAdaptation(channel, value)
            setAdaptationButtonsEnabled(true)

            if (res.success) {
                setResultText("🔍 \${res.message}\\n\\nЗначение $value принято блоком для проверки. Нажмите «СОХРАНИТЬ» для записи в EEPROM.")
            } else {
                setResultText("⚠️ \${res.message}")
            }
        }
    }

    private fun performAdaptationSave() {
        val protocol = kwProtocol ?: return
        val (channel, value) = parseAdaptInputs(needValue = true) ?: return

        lifecycleScope.launch {
            stopAllBackgroundLoops()
            setAdaptationButtonsEnabled(false)
            val res = protocol.saveAdaptation(channel, value)
            setAdaptationButtonsEnabled(true)

            if (res.success) {
                val extra = if (selectedEcuAddress == 0x25 && channel == 0) {
                    "\\n\\n🔑 ВАЖНО ДЛЯ ИММОБИЛАЙЗЕРА:\\nВыключите зажигание минимум на 30 секунд для завершения привязки ЭБУ к иммобилайзеру."
                } else if (selectedEcuAddress == 0x01 && channel == 0) {
                    "\\n\\n🔄 Сброс выученных адаптаций Mono-Motronic выполнен! После выключения зажигания на 15 сек блок заново обучит холостой ход."
                } else ""
                setResultText("✅ \${res.message}$extra")
            } else {
                setResultText("⚠️ \${res.message}")
            }
        }
    }

    private fun showEcuPassport() {
        val protocol = kwProtocol ?: return
        val isImmo = selectedEcuAddress == 0x25
        val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else (if (isImmo) "1H0 953 257" else "3A0 907 311")
        val comp = if (protocol.ecuComponent.isNotEmpty()) protocol.ecuComponent else (if (isImmo) "IMMOBILIZER VDO V01" else "1.8l R4 MONO 1.2.3 D30")
        val extra = if (protocol.ecuExtra.isNotEmpty()) protocol.ecuExtra else "WSC 01317 / Код 00000"

        setResultText("ПАСПОРТНЫЕ ДАННЫЕ БЛОКА УПРАВЛЕНИЯ:\\n" +
                "• Блок: \${if (isImmo) "Иммобилайзер (0x25)" else "ЭБУ Двигателя (0x01)"}\\n" +
                "• Номер VAG: $pNum\\n" +
                "• Компонент: $comp\\n" +
                "• Кодировка / Дилер: $extra\\n" +
                "• Протокол связи: KWP1281 (скорость \${protocol.negotiatedBaud} бод, 8N1)\\n" +
                "• Автомобиль: VW Vento 1995 1.8 ADZ")
    }

    private fun copyDiagnosticReport() {
        try {
            val reportText = tvResults.text.toString()
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("Vento Diagnostic Report", reportText)
            clipboard.setPrimaryClip(clip)
            Toast.makeText(this, "Отчёт скопирован в буфер обмена!", Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, "Не удалось скопировать отчёт", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopAllBackgroundLoops()
        if (isReceiverRegistered) {
            try {
                unregisterReceiver(usbReceiver)
            } catch (e: Exception) {}
            isReceiverRegistered = false
        }
        disconnectSession()
    }
}
`
  },
  {
    path: 'app/src/main/res/values/themes.xml',
    filename: 'themes.xml',
    language: 'xml',
    description: 'Тема MaterialComponents для корректного запуска AppCompatActivity',
    content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="Theme.Material3.Dark" parent="Theme.MaterialComponents.DayNight.NoActionBar">
        <item name="colorPrimary">#38BDF8</item>
        <item name="colorPrimaryVariant">#0284C7</item>
        <item name="colorOnPrimary">#FFFFFF</item>
        <item name="colorSecondary">#10B981</item>
        <item name="android:statusBarColor">#090D16</item>
        <item name="android:navigationBarColor">#090D16</item>
        <item name="android:windowBackground">#090D16</item>
    </style>
</resources>
`
  },
  {
    path: 'app/src/main/AndroidManifest.xml',
    filename: 'AndroidManifest.xml',
    language: 'xml',
    description: 'Манифест Android с правами USB Host и фильтром VID 0x0403 (FTDI)',
    content: `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <uses-feature android:name="android.hardware.usb.host" android:required="true" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:roundIcon="@mipmap/ic_launcher"
        android:label="Vento Diagnostic"
        android:supportsRtl="true"
        android:theme="@style/Theme.Material3.Dark">

        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:theme="@style/Theme.Material3.Dark">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

            <!-- Автоматический запуск при подключении USB KKL адаптера -->
            <intent-filter>
                <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
            </intent-filter>
            <meta-data
                android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
                android:resource="@xml/device_filter" />
        </activity>
    </application>

</manifest>
`
  },
  {
    path: 'app/src/main/res/xml/device_filter.xml',
    filename: 'device_filter.xml',
    language: 'xml',
    description: 'USB фильтр VID/PID для чипов FTDI FT232, CH340, CP2102',
    content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- FTDI FT232RL / FT232BL (Классический синий KKL VAG-COM 409.1) -->
    <usb-device vendor-id="1027" product-id="24577" /> <!-- VID 0x0403, PID 0x6001 -->
    <usb-device vendor-id="1027" product-id="24592" /> <!-- VID 0x0403, PID 0x6010 -->
    <usb-device vendor-id="1027" product-id="24596" /> <!-- VID 0x0403, PID 0x6014 -->
    <usb-device vendor-id="1027" product-id="24597" /> <!-- VID 0x0403, PID 0x6015 -->

    <!-- WCH CH340 (Бюджетные KKL кабели) -->
    <usb-device vendor-id="6790" product-id="29987" /> <!-- VID 0x1A86, PID 0x7523 -->

    <!-- Silicon Labs CP2102 -->
    <usb-device vendor-id="4292" product-id="60000" /> <!-- VID 0x10C4, PID 0xEA60 -->
</resources>
`
  },
  {
    path: 'app/build.gradle.kts',
    filename: 'build.gradle.kts',
    language: 'groovy',
    description: 'Сборочный скрипт модуля с быстрой и надежной библиотекой AndroidX и usb-serial-for-android',
    content: `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.vag.kw1281"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.vag.kw1281"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    
    // USB Serial драйвер для Android OTG
    implementation("com.github.mik3y:usb-serial-for-android:3.8.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
`
  },
  {
    path: 'settings.gradle.kts',
    filename: 'settings.gradle.kts',
    language: 'groovy',
    description: 'Корневая настройка репозиториев Gradle и JitPack для сборки в GitHub Actions',
    content: `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        maven { url = java.net.URI("https://jitpack.io") }
    }
}

rootProject.name = "KW1281Diag"
include(":app")
`
  },
  {
    path: 'build.gradle.kts',
    filename: 'build.gradle.kts (root)',
    language: 'groovy',
    description: 'Корневой build.gradle со ссылками на Android Gradle Plugin и Kotlin',
    content: `plugins {
    id("com.android.application") version "8.3.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.23" apply false
}
`
  },
  {
    path: 'gradle/wrapper/gradle-wrapper.properties',
    filename: 'gradle-wrapper.properties',
    language: 'properties',
    description: 'Версия Gradle Wrapper для автоматической загрузки раннером GitHub',
    content: `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.4-bin.zip
networkTimeout=10000
validateDistributionUrl=true
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`
  },
  {
    path: 'gradle.properties',
    filename: 'gradle.properties',
    language: 'properties',
    description: 'Настройки памяти JVM и поддержка AndroidX для компилятора',
    content: `org.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8
android.useAndroidX=true
android.nonTransitiveRClass=true
kotlin.daemon.jvmargs=-Xmx2048m
`
  },
  {
    path: 'app/src/main/res/values/strings.xml',
    filename: 'strings.xml',
    language: 'xml',
    description: 'Название приложения Vento Diagnostic',
    content: `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Vento Diagnostic</string>
</resources>
`
  },
  {
    path: 'README.md',
    filename: 'README.md',
    language: 'markdown',
    description: 'Пошаговое руководство по автоматической сборке APK через GitHub Actions',
    content: `# VAG KW1281 Android Diagnostic App
### Для VW Vento 1995 1.8 ADZ / Mono-Motronic 1.2.3 (3A0 907 311)

## 🚀 Как собрать APK на GitHub (в облаке без Android Studio):
1. **Создайте репозиторий на GitHub**:
   - Нажмите **New repository** (например, с именем \`kw1281-vento-android\`).
2. **Загрузите файлы проекта**:
   - Распакуйте скачанный из этого приложения ZIP-архив.
   - Загрузите все папки и файлы (включая папку \`.github/\`) в репозиторий через Git или кнопку **Add file -> Upload files**.
3. **Автоматический запуск сборки**:
   - Перейдите во вкладку **Actions** в репозитории на GitHub.
   - Воркфлоу **"Build Android APK (KW1281 Diag)"** запустится автоматически.
   - Также вы можете в любой момент нажать кнопку **"Run workflow"** вручную.
4. **Скачивание готового APK**:
   - Через 1–2 минуты сборка завершится с зелёной отметкой ✅.
   - Нажмите на название завершённого запуска во вкладке Actions.
   - В самом низу страницы в блоке **Artifacts** нажмите на **\`kw1281-vento-debug-apk\`**.
   - Скачается архив с готовым \`app-debug.apk\`, который можно сразу скинуть на телефон (Ulefone Armor 21) и установить!

## 📱 Подключение к автомобилю VW Vento 1995:
1. Вставьте адаптер KKL USB FT232 в диагностический разъём автомобиля (OBD-II или переходник 2x2).
2. Подключите адаптер к телефону через переходник USB-OTG.
3. Включите зажигание (заводить мотор не обязательно).
4. Подтвердите доступ к USB в появившемся окне Android.
5. Нажмите «Подключить к ЭБУ».
`
  }
];

export async function createAndroidProjectZip(): Promise<Blob> {
  const zip = new JSZip();

  ANDROID_PROJECT_FILES.forEach((file) => {
    zip.file(file.path, file.content);
  });

  try {
    const iconRes = await fetch('/vento_icon.png');
    if (iconRes.ok) {
      const iconBlob = await iconRes.blob();
      zip.file('app/src/main/res/drawable/ic_launcher.png', iconBlob);
      zip.file('app/src/main/res/mipmap-mdpi/ic_launcher.png', iconBlob);
      zip.file('app/src/main/res/mipmap-hdpi/ic_launcher.png', iconBlob);
      zip.file('app/src/main/res/mipmap-xhdpi/ic_launcher.png', iconBlob);
      zip.file('app/src/main/res/mipmap-xxhdpi/ic_launcher.png', iconBlob);
      zip.file('app/src/main/res/mipmap-xxxhdpi/ic_launcher.png', iconBlob);
    }
  } catch (err) {
    console.warn('Could not bundle icon into ZIP', err);
  }

  return await zip.generateAsync({ type: 'blob' });
}
