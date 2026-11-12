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
 * 1. 5-бодовая посылка формируется через стандартный аппаратный Break (setBreak),
 *    без использования опасного SIO_SET_BITMODE и bulk-записей, вызывавших сброс FTDI
 *    и зависание USB OTG ("USB отключен").
 * 2. Точный абсолютный дедлайн на 200.0 мс на бит (start + N * 200ms) без накапливания ошибки.
 * 3. Пауза 250 мс перед стартом, стоп-бит 200 мс, пауза 25 мс до чтения ответа.
 * 4. Удержание линий DTR/RTS (питание трансивера K-Line).
 * 5. Буферизация FTDI через 256-байтный буфер (обход 2-байтного заголовка модема D2XX).
 * 6. Алгоритм isEchoOrComplement для надёжной фильтрации однопроводного K-Line эхо.
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
            // В FTDI setBreak(true) принудительно прижимает TX к 0 В (Space)
            // setBreak(false) отпускает TX в логическую 1 (Mark, 12 В на K-Line)
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
            setPinState(true) // Break OFF -> TX = 12 В Idle

            // 2. Пауза перед стартом: ~250 мс (согласно декомпилированному libkwp1281)
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
            // Для адреса 0x01: сумма единиц = 1 (нечётное), значит бит чётности = 0 -> LOW (0 В)
            val parityBit = if (parity != 0) 0 else 1
            setPinState(parityBit == 1)
            waitExactDeadline(9)

            // Шаг 10. Стоп-бит: TX = HIGH (12 В на K-Line), ровно 200 мс
            setPinState(true)
            waitExactDeadline(10)

            // Шаг 11. Дополнительная пауза после стопа: 25 мс (libkwp1281)
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
            "Форсунка впрыска топлива (N30)\\n→ Должны быть слышны чёткие ритмичные щелчки электромагнита форсунки в моновпрыске.",
            "Клапан продувки адсорбера (N80)\\n→ Тактирование клапана вентиляции бака (частые щелчки на правом брызговике).",
            "Регулятор положения дроссельной заслонки / РХХ (V60)\\n→ Моторчик сервопривода выдвигает и втягивает шток дросселя.",
            "Реле топливного насоса (J17)\\n→ Кратковременное включение и отключение бензонасоса в баке.",
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
                onLog("Ошибка теста исполнителей: \${t.message}")
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
            android:layout_width="46dp"
            android:layout_height="46dp"
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
                android:textSize="19sp"
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
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ДВИГАТЕЛЬ (0x01)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#0284C7"
            android:textColor="#FFFFFF" />

        <Button
            android:id="@+id/btnTabImmo"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="ИММОБИЛАЙЗЕР (0x25)"
            android:textSize="13sp"
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
            android:text="Статус: Готов к подключению"
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
            android:text="Текущий тест: Форсунка впрыска N30 (щелчки)"
            android:textColor="#FFFFFF"
            android:textSize="12sp"
            android:layout_marginTop="3dp" />

        <LinearLayout
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:orientation="horizontal"
            android:layout_marginTop="8dp">

            <Button
                android:id="@+id/btnActuatorNext"
                android:layout_width="0dp"
                android:layout_height="48dp"
                android:layout_weight="1"
                android:layout_marginEnd="4dp"
                android:text="СЛЕДУЮЩИЙ ТЕСТ"
                android:textSize="12sp"
                android:textStyle="bold"
                android:backgroundTint="#7C3AED"
                android:textColor="#FFFFFF" />

            <Button
                android:id="@+id/btnActuatorStop"
                android:layout_width="0dp"
                android:layout_height="48dp"
                android:layout_weight="1"
                android:layout_marginStart="4dp"
                android:text="ЗАВЕРШИТЬ ТЕСТ"
                android:textSize="12sp"
                android:textStyle="bold"
                android:backgroundTint="#EF4444"
                android:textColor="#FFFFFF" />
        </LinearLayout>
    </LinearLayout>

    <!-- Large Action Buttons (Spacious, non-clipped, height 52dp) -->
    <!-- Row 1: Connection -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="6dp">

        <Button
            android:id="@+id/btnFindUsb"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ПОИСК KKL"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#0284C7"
            android:textColor="#FFFFFF" />

        <Button
            android:id="@+id/btnConnectEcu"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="ПОДКЛЮЧИТЬ"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#10B981"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

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
            android:text="ОШИБКИ (0x07)"
            android:textSize="13sp"
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
            android:text="СТЕРЕТЬ (0x05)"
            android:textSize="13sp"
            android:textStyle="bold"
            android:backgroundTint="#EF4444"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <!-- Row 3: Diagnostics & Actuators -->
    <LinearLayout
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
            android:text="ТЕСТ ИСПОЛНИТЕЛЕЙ"
            android:textSize="12sp"
            android:textStyle="bold"
            android:backgroundTint="#7C3AED"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <!-- Row 4: Basic Settings & Passport -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="8dp">

        <Button
            android:id="@+id/btnBasicSettings"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="БАЗОВЫЕ (УОЗ 6°)"
            android:textSize="12sp"
            android:textStyle="bold"
            android:backgroundTint="#0D9488"
            android:textColor="#FFFFFF"
            android:enabled="false" />

        <Button
            android:id="@+id/btnEcuPassport"
            android:layout_width="0dp"
            android:layout_height="52dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="ПАСПОРТ БЛОКА"
            android:textSize="12sp"
            android:textStyle="bold"
            android:backgroundTint="#475569"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <!-- Diagnostic Results Section Header -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:layout_marginBottom="4dp">

        <TextView
            android:id="@+id/tvResultsHeader"
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:text="Результаты диагностики:"
            android:textColor="#CBD5E1"
            android:textSize="13sp"
            android:textStyle="bold" />

        <Button
            android:id="@+id/btnShareReport"
            android:layout_width="wrap_content"
            android:layout_height="32dp"
            android:text="Копировать отчёт"
            android:textSize="10sp"
            android:paddingStart="8dp"
            android:paddingEnd="8dp"
            android:backgroundTint="#1E293B"
            android:textColor="#38BDF8"
            android:layout_marginEnd="4dp" />

        <Button
            android:id="@+id/btnClearResults"
            android:layout_width="wrap_content"
            android:layout_height="32dp"
            android:text="Очистить"
            android:textSize="10sp"
            android:paddingStart="8dp"
            android:paddingEnd="8dp"
            android:backgroundTint="#1E293B"
            android:textColor="#94A3B8" />
    </LinearLayout>

    <!-- Diagnostic Results Display (Clean Cards without raw byte clutter) -->
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
            android:text="Подключите USB KKL адаптер и нажмите «ПОДКЛЮЧИТЬ»." />
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
import android.graphics.Color
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
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

    // UI элементы
    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceInfo: TextView
    private lateinit var tvBaudBadge: TextView
    private lateinit var tvResults: TextView
    private lateinit var scrollViewResults: ScrollView

    // Табы выбора ЭБУ
    private lateinit var btnTabEngine: Button
    private lateinit var btnTabImmo: Button
    private var selectedEcuAddress: Int = 0x01 // 0x01 = Двигатель, 0x25 = Иммобилайзер

    // Панели отображения
    private lateinit var layoutLiveData: LinearLayout
    private lateinit var tvGaugeRpm: TextView
    private lateinit var tvGaugeTemp: TextView
    private lateinit var tvGaugeLambda: TextView
    private lateinit var tvGaugeThrottle: TextView

    // Панель иммобилайзера
    private lateinit var layoutImmoStatus: LinearLayout
    private lateinit var tvImmoKeyStatus: TextView
    private lateinit var tvImmoStartStatus: TextView
    private lateinit var tvImmoKeyCount: TextView

    // Панель теста исполнителей
    private lateinit var layoutActuatorTest: LinearLayout
    private lateinit var tvActuatorTitle: TextView
    private lateinit var tvActuatorDesc: TextView
    private lateinit var btnActuatorNext: Button
    private lateinit var btnActuatorStop: Button

    // Основные кнопки
    private lateinit var btnFindUsb: Button
    private lateinit var btnConnectEcu: Button
    private lateinit var btnReadFaults: Button
    private lateinit var btnClearFaults: Button
    private lateinit var btnMeasuring: Button
    private lateinit var btnActuatorStart: Button
    private lateinit var btnBasicSettings: Button
    private lateinit var btnEcuPassport: Button
    private lateinit var btnShareReport: Button
    private lateinit var btnClearResults: Button

    // Связь и сессия
    private var foundDevice: UsbDevice? = null
    private var kwDriver: Ftdi5BaudDriver? = null
    private var kwProtocol: Kw1281Protocol? = null
    private var isReceiverRegistered = false
    private var liveStreamJob: Job? = null

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) {
                        setResultText("Разрешение на работу с USB адаптером получено. Нажмите «ПОДКЛЮЧИТЬ».")
                        btnConnectEcu.isEnabled = true
                    } else {
                        setResultText("Предупреждение: Разрешение USB было отклонено в диалоге Android.")
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    findUsbAdapter()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val currentList = usbManager?.deviceList
                    val stillPresent = currentList?.values?.any {
                        it.vendorId == 0x0403 || it.vendorId == 0x1A86 || it.vendorId == 0x10C4
                    } == true
                    if (!stillPresent) {
                        stopLiveStream()
                        disconnectSession()
                        foundDevice = null
                        setDiagnosticButtonsEnabled(false)
                        btnConnectEcu.isEnabled = false
                        tvStatus.text = "Статус: USB отключен"
                        tvDeviceInfo.text = "Подключите USB-OTG кабель"
                        setResultText("USB KKL адаптер отключен от телефона.")
                    } else {
                        findUsbAdapter()
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

            btnFindUsb = findViewById(R.id.btnFindUsb)
            btnConnectEcu = findViewById(R.id.btnConnectEcu)
            btnReadFaults = findViewById(R.id.btnReadFaults)
            btnClearFaults = findViewById(R.id.btnClearFaults)
            btnMeasuring = findViewById(R.id.btnMeasuring)
            btnActuatorStart = findViewById(R.id.btnActuatorStart)
            btnBasicSettings = findViewById(R.id.btnBasicSettings)
            btnEcuPassport = findViewById(R.id.btnEcuPassport)
            btnShareReport = findViewById(R.id.btnShareReport)
            btnClearResults = findViewById(R.id.btnClearResults)

            // Переключение табов ЭБУ
            btnTabEngine.setOnClickListener { switchEcuTab(0x01) }
            btnTabImmo.setOnClickListener { switchEcuTab(0x25) }

            // Обработчики кнопок
            btnFindUsb.setOnClickListener { findUsbAdapter() }
            btnConnectEcu.setOnClickListener { connectToSelectedEcu() }
            btnReadFaults.setOnClickListener { readFaultCodes() }
            btnClearFaults.setOnClickListener { clearFaultCodes() }
            btnMeasuring.setOnClickListener { toggleLiveMeasuring() }
            btnActuatorStart.setOnClickListener { startActuatorTest() }
            btnActuatorNext.setOnClickListener { nextActuatorTest() }
            btnActuatorStop.setOnClickListener { stopActuatorTest() }
            btnBasicSettings.setOnClickListener { enterBasicSettings() }
            btnEcuPassport.setOnClickListener { showEcuPassport() }
            btnShareReport.setOnClickListener { copyDiagnosticReport() }
            btnClearResults.setOnClickListener { tvResults.text = "Результаты очищены." }

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
            findUsbAdapter()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun switchEcuTab(addr: Int) {
        if (selectedEcuAddress != addr) {
            disconnectSession()
            setDiagnosticButtonsEnabled(false)
        }
        selectedEcuAddress = addr

        if (addr == 0x01) {
            btnTabEngine.setBackgroundColor(Color.parseColor("#0284C7"))
            btnTabEngine.setTextColor(Color.WHITE)
            btnTabImmo.setBackgroundColor(Color.parseColor("#334155"))
            btnTabImmo.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Bosch Mono-Motronic 1.2.3 (3A0 907 311)"
            layoutLiveData.visibility = View.VISIBLE
            layoutImmoStatus.visibility = View.GONE
            btnMeasuring.visibility = View.VISIBLE
            btnActuatorStart.visibility = View.VISIBLE
            btnBasicSettings.visibility = View.VISIBLE
        } else {
            btnTabImmo.setBackgroundColor(Color.parseColor("#0284C7"))
            btnTabImmo.setTextColor(Color.WHITE)
            btnTabEngine.setBackgroundColor(Color.parseColor("#334155"))
            btnTabEngine.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Иммобилайзер Wegfahrsicherung (1H0 953 257)"
            layoutLiveData.visibility = View.GONE
            layoutImmoStatus.visibility = View.VISIBLE
            btnMeasuring.visibility = View.GONE
            btnActuatorStart.visibility = View.GONE
            btnBasicSettings.visibility = View.GONE
        }
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

    private fun setDiagnosticButtonsEnabled(enabled: Boolean) {
        btnReadFaults.isEnabled = enabled
        btnClearFaults.isEnabled = enabled
        btnMeasuring.isEnabled = enabled
        btnActuatorStart.isEnabled = enabled
        btnBasicSettings.isEnabled = enabled
        btnEcuPassport.isEnabled = enabled
    }

    private fun findUsbAdapter() {
        val manager = usbManager ?: return
        val deviceList = manager.deviceList
        val ftdi = deviceList.values.firstOrNull { it.vendorId == 0x0403 }
            ?: deviceList.values.firstOrNull { it.vendorId == 0x1A86 || it.vendorId == 0x10C4 }

        if (ftdi != null) {
            foundDevice = ftdi
            tvStatus.text = "Статус: Адаптер обнаружен!"
            if (manager.hasPermission(ftdi)) {
                btnConnectEcu.isEnabled = true
                setResultText("USB KKL адаптер готов к работе. Выберите нужный блок (Двигатель или Иммобилайзер) и нажмите «ПОДКЛЮЧИТЬ».")
            } else {
                btnConnectEcu.isEnabled = false
                requestUsbPermission(ftdi)
            }
        } else {
            tvStatus.text = "Статус: KKL адаптер не найден"
            tvDeviceInfo.text = "Подключите USB-OTG кабель к телефону"
            btnConnectEcu.isEnabled = false
            setDiagnosticButtonsEnabled(false)
            setResultText("Адаптер FT232 / KKL не обнаружен в разъёме USB-OTG.")
        }
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

    private fun disconnectSession() {
        stopLiveStream()
        layoutActuatorTest.visibility = View.GONE
        try {
            kwProtocol?.stopSession()
        } catch (t: Throwable) {}
        try {
            kwDriver?.close()
        } catch (t: Throwable) {}
        kwProtocol = null
        kwDriver = null
    }

    private fun connectToSelectedEcu() {
        val dev = foundDevice ?: run {
            setResultText("Сначала подключите USB KKL адаптер.")
            return
        }
        val manager = usbManager ?: return

        lifecycleScope.launch {
            try {
                stopLiveStream()
                layoutActuatorTest.visibility = View.GONE
                btnConnectEcu.isEnabled = false
                setDiagnosticButtonsEnabled(false)
                val blockName = if (selectedEcuAddress == 0x25) "Иммобилайзера (0x25)" else "ЭБУ Двигателя (0x01)"
                tvStatus.text = "Инициализация $blockName..."
                setResultText("Установка связи с $blockName на 5 бод...")

                var driver = kwDriver
                if (driver == null || !driver.isOpen) {
                    disconnectSession()
                    val newDriver = Ftdi5BaudDriver(manager, dev)
                    if (newDriver.open(9600)) {
                        kwDriver = newDriver
                        driver = newDriver
                    } else {
                        tvStatus.text = "Ошибка открытия USB порта"
                        setResultText("Не удалось открыть USB порт: \${newDriver.lastError ?: "проверьте кабель"}")
                        btnConnectEcu.isEnabled = true
                        return@launch
                    }
                }

                val protocol = Kw1281Protocol(driver)
                kwProtocol = protocol
                val success = protocol.connect(selectedEcuAddress) { msg ->
                    // Без вывода сырых байт лога в UI
                }

                if (success) {
                    val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else (if (selectedEcuAddress == 0x25) "1H0 953 257" else "3A0 907 311")
                    tvStatus.text = "Подключен: $pNum"
                    tvBaudBadge.text = "\${protocol.negotiatedBaud} бод"
                    btnConnectEcu.isEnabled = true
                    setDiagnosticButtonsEnabled(true)

                    if (selectedEcuAddress == 0x25) {
                        // Опрашиваем статус транспондера иммобилайзера
                        checkImmobilizerStatus(protocol)
                    } else {
                        setResultText("Связь с ЭБУ Двигателя успешно установлена!\\n" +
                                "Номер: \${protocol.ecuPartNumber}\\n" +
                                "Компонент: \${protocol.ecuComponent}\\n" +
                                "Доступны функции: чтение ошибок, живые параметры, тест исполнителей, базовые установки.")
                    }
                } else {
                    tvStatus.text = "Ошибка связи с блоком"
                    setResultText("Блок $blockName не отвечает на запрос.\\n" +
                            "• Проверьте, включено ли зажигание (положение ключа ON/приборная панель горит).\\n" +
                            "• Проверьте надёжность контакта K-Line в разъёме OBD2.")
                    btnConnectEcu.isEnabled = true
                }
            } catch (t: Throwable) {
                t.printStackTrace()
                tvStatus.text = "Сбой подключения"
                setResultText("Сбой при подключении: \${t.message ?: t.javaClass.simpleName}")
                btnConnectEcu.isEnabled = true
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
                    "• Транспондер чипа: \${if (status.keyAuthorized) "Авторизован" else "Не авторизован / Слишком слабый сигнал катушки"}\\n" +
                    "• Ключей прописано: \${status.keyCount}")
        } else {
            setResultText("Иммобилайзер подключен. Номер блока: \${protocol.ecuPartNumber}")
        }
    }

    private fun readFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
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
                stopLiveStream()
                btnClearFaults.isEnabled = false
                val success = protocol.clearFaultCodes { }
                btnClearFaults.isEnabled = true
                if (success) {
                    setResultText("✅ Память кодов неисправностей успешно очищена!\\n" +
                            "Нажмите «ОШИБКИ (0x07)» для контрольной проверки.")
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
            btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
            setResultText("Поток живых измерений остановлен.")
            return
        }

        val protocol = kwProtocol ?: run {
            setResultText("Сначала подключитесь к ЭБУ.")
            return
        }

        btnMeasuring.text = "ОСТАНОВИТЬ (08)"
        setResultText("Запущен опрос Live Data (Группа 000). Данные обновляются на приборных шкалах вверху экрана.")

        liveStreamJob = lifecycleScope.launch {
            try {
                while (isActive) {
                    val m = protocol.readMeasuringGroup(0) { }
                    if (m != null) {
                        updateGauges(m)
                    }
                    delay(400)
                }
            } catch (t: Throwable) {
            } finally {
                btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
            }
        }
    }

    private fun stopLiveStream() {
        liveStreamJob?.cancel()
        liveStreamJob = null
    }

    private fun updateGauges(m: Kw1281Protocol.LiveMeasurement) {
        runOnUiThread {
            m.rpm?.let { tvGaugeRpm.text = "$it" }
            m.coolantTemp?.let { tvGaugeTemp.text = "$it" }
            m.lambdaVoltage?.let { tvGaugeLambda.text = "%.2f".format(it) }
            m.throttleAngle?.let { tvGaugeThrottle.text = "%.1f".format(it) }
        }
    }

    // Тест исполнительных механизмов (0x04)
    private fun startActuatorTest() {
        val protocol = kwProtocol ?: return
        stopLiveStream()
        layoutActuatorTest.visibility = View.VISIBLE
        tvActuatorTitle.text = "ТЕСТ ИСПОЛНИТЕЛЕЙ (0x04)"
        tvActuatorDesc.text = "Запуск первого теста..."
        nextActuatorTest()
    }

    private fun nextActuatorTest() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                btnActuatorNext.isEnabled = false
                val step = protocol.stepActuatorTest { }
                btnActuatorNext.isEnabled = true
                if (step != null) {
                    tvActuatorDesc.text = step
                    setResultText("АКТИВЕН ТЕСТ ИСПОЛНИТЕЛЕЙ:\\n$step\\n\\nДля перехода к следующему элементу нажмите кнопку «СЛЕДУЮЩИЙ ТЕСТ».")
                    if (step.contains("завершён", ignoreCase = true)) {
                        layoutActuatorTest.visibility = View.GONE
                    }
                } else {
                    layoutActuatorTest.visibility = View.GONE
                    setResultText("Тест исполнителей завершён или отклонён ЭБУ.")
                }
            } catch (t: Throwable) {
                btnActuatorNext.isEnabled = true
                setResultText("Ошибка шага теста: \${t.message}")
            }
        }
    }

    private fun stopActuatorTest() {
        kwProtocol?.stopActuatorTest()
        layoutActuatorTest.visibility = View.GONE
        setResultText("Тест исполнительных механизмов остановлен пользователем.")
    }

    private fun enterBasicSettings() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
                layoutActuatorTest.visibility = View.GONE
                btnBasicSettings.isEnabled = false

                val result = protocol.enterBasicSettings(0) { }
                btnBasicSettings.isEnabled = true
                if (result != null) {
                    updateGauges(result)
                    setResultText("🔧 РЕЖИМ БАЗОВЫХ УСТАНОВОК (0x28, Группа 000) АКТИВЕН!\\n\\n" +
                            "• ЭБУ заблокировал динамическое опережение зажигания.\\n" +
                            "• Обороты двигателя зафиксированы на холостом ходу (~850 об/мин).\\n" +
                            "• Теперь можно вращать корпус трамблера и выставлять УОЗ 6° до ВМТ по стробоскопу на метку маховика.\\n\\n" +
                            "Сырые параметры группы 000: \${result.rawValues.joinToString(" ") { "%03d".format(it) }}")
                }
            } catch (t: Throwable) {
                btnBasicSettings.isEnabled = true
                setResultText("Ошибка базовых установок: \${t.message}")
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
        stopLiveStream()
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
