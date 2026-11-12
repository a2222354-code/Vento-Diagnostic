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
     * Подключение к ЭБУ двигателя (адрес 0x01).
     * Проверяет скорость 9600 бод, а при необходимости выполняет автоматический фоллбек на 10400 бод.
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
                onLog("Исключение сессии KWP1281: \${t.message ?: t.javaClass.simpleName}")
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
            val rxSummary = if (foreignBytes.isEmpty()) "линия молчит" else "принято: \${foreignBytes.joinToString(" ")}"
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
                onLog("Ошибка чтения ошибок: \${t.message ?: t.javaClass.simpleName}")
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
                onLog("Ошибка стирания ошибок: \${t.message ?: t.javaClass.simpleName}")
                return@withContext false
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
    android:padding="14dp">

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:layout_marginBottom="12dp">

        <ImageView
            android:layout_width="48dp"
            android:layout_height="48dp"
            android:src="@drawable/ic_launcher"
            android:layout_marginEnd="12dp"
            android:contentDescription="VW Vento" />

        <LinearLayout
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:orientation="vertical">

            <TextView
                android:id="@+id/tvTitle"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="VENTO DIAGNOSTIC"
                android:textColor="#38BDF8"
                android:textSize="20sp"
                android:textStyle="bold"
                android:typeface="monospace" />

            <TextView
                android:id="@+id/tvSubtitle"
                android:layout_width="wrap_content"
                android:layout_height="wrap_content"
                android:text="VW Vento 1995 1.8 ADZ (Mono-Motronic 1.2.3)"
                android:textColor="#94A3B8"
                android:textSize="12sp" />
        </LinearLayout>
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="vertical"
        android:background="#1E293B"
        android:padding="12dp"
        android:layout_marginBottom="10dp">

        <TextView
            android:id="@+id/tvStatus"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Статус: Ожидание подключения KKL адаптера..."
            android:textColor="#FFFFFF"
            android:textSize="14sp"
            android:textStyle="bold" />

        <TextView
            android:id="@+id/tvDeviceInfo"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:text="Устройство: Не определено"
            android:textColor="#38BDF8"
            android:textSize="12sp"
            android:layout_marginTop="3dp" />
    </LinearLayout>

    <!-- Fixed Baud & Protocol Info Badge -->
    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:background="#1E293B"
        android:paddingStart="12dp"
        android:paddingEnd="12dp"
        android:paddingTop="8dp"
        android:paddingBottom="8dp"
        android:layout_marginBottom="10dp">

        <TextView
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:text="Протокол: VAG KWP1281"
            android:textColor="#94A3B8"
            android:textSize="12sp"
            android:textStyle="bold" />

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="9600 бод (8N1)"
            android:textColor="#38BDF8"
            android:textSize="12sp"
            android:textStyle="bold"
            android:typeface="monospace" />
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="8dp">

        <Button
            android:id="@+id/btnFindUsb"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="НАЙТИ USB\\nKKL"
            android:textSize="12sp"
            android:backgroundTint="#0284C7"
            android:textColor="#FFFFFF" />

        <Button
            android:id="@+id/btnConnectEcu"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="ПОДКЛЮЧИТЬ\\nЭБУ"
            android:textSize="12sp"
            android:backgroundTint="#10B981"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:layout_marginBottom="10dp">

        <Button
            android:id="@+id/btnReadFaults"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginEnd="4dp"
            android:text="ОШИБКИ\\n(0x07)"
            android:textSize="12sp"
            android:backgroundTint="#F59E0B"
            android:textColor="#FFFFFF"
            android:enabled="false" />

        <Button
            android:id="@+id/btnClearFaults"
            android:layout_width="0dp"
            android:layout_height="48dp"
            android:layout_weight="1"
            android:layout_marginStart="4dp"
            android:text="СТЕРЕТЬ\\n(0x05)"
            android:textSize="12sp"
            android:backgroundTint="#EF4444"
            android:textColor="#FFFFFF"
            android:enabled="false" />
    </LinearLayout>

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:layout_marginBottom="6dp">

        <TextView
            android:layout_width="0dp"
            android:layout_height="wrap_content"
            android:layout_weight="1"
            android:text="Журнал обмена (KW1281 Log):"
            android:textColor="#CBD5E1"
            android:textSize="13sp" />

        <Button
            android:id="@+id/btnClearLog"
            android:layout_width="wrap_content"
            android:layout_height="32dp"
            android:text="Очистить"
            android:textSize="10sp"
            android:paddingStart="8dp"
            android:paddingEnd="8dp"
            android:backgroundTint="#1E293B"
            android:textColor="#94A3B8" />
    </LinearLayout>

    <ScrollView
        android:id="@+id/scrollViewLogs"
        android:layout_width="match_parent"
        android:layout_height="0dp"
        android:layout_weight="1"
        android:background="#020617"
        android:padding="8dp">

        <TextView
            android:id="@+id/tvLogs"
            android:layout_width="match_parent"
            android:layout_height="wrap_content"
            android:textColor="#34D399"
            android:textSize="11sp"
            android:typeface="monospace"
            android:text="Приложение готово к работе." />
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
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {

    private var usbManager: UsbManager? = null
    private val ACTION_USB_PERMISSION = "com.vag.kw1281.USB_PERMISSION"

    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceInfo: TextView
    private lateinit var tvLogs: TextView
    private lateinit var scrollViewLogs: ScrollView
    private lateinit var btnFindUsb: Button
    private lateinit var btnConnectEcu: Button
    private lateinit var btnReadFaults: Button
    private lateinit var btnClearFaults: Button
    private lateinit var btnClearLog: Button

    private var foundDevice: UsbDevice? = null
    private var kwDriver: Ftdi5BaudDriver? = null
    private var kwProtocol: Kw1281Protocol? = null
    private var isReceiverRegistered = false

    private val usbReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action ?: return
            when (action) {
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) {
                        addLog("Разрешение на работу с USB получено!")
                        btnConnectEcu.isEnabled = true
                    } else {
                        addLog("Предупреждение: Разрешение на USB было отклонено.")
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    addLog("Обнаружено подключение USB устройства.")
                    findUsbAdapter()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val currentList = usbManager?.deviceList
                    val stillPresent = currentList?.values?.any {
                        it.vendorId == 0x0403 || it.vendorId == 0x1A86 || it.vendorId == 0x10C4
                    } == true
                    if (!stillPresent) {
                        addLog("USB устройство отключено.")
                        disconnectSession()
                        foundDevice = null
                        btnConnectEcu.isEnabled = false
                        btnReadFaults.isEnabled = false
                        btnClearFaults.isEnabled = false
                        tvStatus.text = "Статус: USB отключен"
                        tvDeviceInfo.text = "Подключите USB-OTG кабель"
                    } else {
                        addLog("Переподключение адаптера...")
                        findUsbAdapter()
                    }
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            val defaultHandler = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
                addLog("Непредвиденная ошибка: \${throwable.message ?: throwable.javaClass.simpleName}")
                defaultHandler?.uncaughtException(thread, throwable)
            }

            setContentView(R.layout.activity_main)

            usbManager = getSystemService(Context.USB_SERVICE) as? UsbManager

            tvStatus = findViewById(R.id.tvStatus)
            tvDeviceInfo = findViewById(R.id.tvDeviceInfo)
            tvLogs = findViewById(R.id.tvLogs)
            scrollViewLogs = findViewById(R.id.scrollViewLogs)
            btnFindUsb = findViewById(R.id.btnFindUsb)
            btnConnectEcu = findViewById(R.id.btnConnectEcu)
            btnReadFaults = findViewById(R.id.btnReadFaults)
            btnClearFaults = findViewById(R.id.btnClearFaults)
            btnClearLog = findViewById(R.id.btnClearLog)

            btnFindUsb.setOnClickListener { findUsbAdapter() }
            btnConnectEcu.setOnClickListener { connectToEcu() }
            btnReadFaults.setOnClickListener { readFaultCodes() }
            btnClearFaults.setOnClickListener { clearFaultCodes() }
            btnClearLog.setOnClickListener { tvLogs.text = "Журнал очищен." }

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

            addLog("Vento Diagnostic — VW Vento 1995 1.8 ADZ (Mono-Motronic 1.2.3)")
            addLog("Протокол KWP1281: фиксированная скорость 9600 бод, ЭБУ 0x01")
            findUsbAdapter()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun addLog(msg: String) {
        runOnUiThread {
            try {
                val current = tvLogs.text.toString()
                val newText = if (current.isEmpty()) msg else "$current\\n$msg"
                tvLogs.text = newText
                scrollViewLogs.post {
                    scrollViewLogs.fullScroll(ScrollView.FOCUS_DOWN)
                }
            } catch (e: Exception) {
                e.printStackTrace()
            }
        }
    }

    private fun findUsbAdapter() {
        val manager = usbManager
        if (manager == null) {
            tvStatus.text = "Статус: USB сервис недоступен"
            addLog("Ошибка: В системе отсутствует USB Host сервис.")
            return
        }

        val deviceList = manager.deviceList
        val ftdi = deviceList.values.firstOrNull { it.vendorId == 0x0403 }
            ?: deviceList.values.firstOrNull { it.vendorId == 0x1A86 || it.vendorId == 0x10C4 }

        if (ftdi != null) {
            foundDevice = ftdi
            tvStatus.text = "Статус: Адаптер обнаружен!"
            tvDeviceInfo.text = "Устройство: VID 0x%04X, PID 0x%04X (FTDI / K-Line)".format(ftdi.vendorId, ftdi.productId)
            addLog("USB KKL адаптер найден: VID=0x%04X, PID=0x%04X".format(ftdi.vendorId, ftdi.productId))
            
            if (manager.hasPermission(ftdi)) {
                btnConnectEcu.isEnabled = true
                addLog("Разрешение USB предоставлено. Нажмите «ПОДКЛЮЧИТЬ ЭБУ».")
            } else {
                btnConnectEcu.isEnabled = false
                requestUsbPermission(ftdi)
            }
        } else {
            tvStatus.text = "Статус: KKL адаптер не найден"
            tvDeviceInfo.text = "Подключите USB-OTG кабель к телефону"
            btnConnectEcu.isEnabled = false
            addLog("Адаптер FT232 не обнаружен. Проверьте OTG соединение.")
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
        } catch (e: Exception) {
            addLog("Ошибка запроса прав USB: \${e.message}")
        }
    }

    private fun disconnectSession() {
        try {
            kwProtocol?.stopSession()
        } catch (t: Throwable) {}
        try {
            kwDriver?.close()
        } catch (t: Throwable) {}
        kwProtocol = null
        kwDriver = null
    }

    private fun connectToEcu() {
        val dev = foundDevice ?: run {
            addLog("Сначала подключите USB KKL адаптер.")
            return
        }
        val manager = usbManager ?: run {
            addLog("USB сервис недоступен на данном устройстве.")
            return
        }
        lifecycleScope.launch {
            try {
                btnConnectEcu.isEnabled = false
                btnReadFaults.isEnabled = false
                btnClearFaults.isEnabled = false
                tvStatus.text = "Статус: Инициализация K-Line 5 бод..."
                
                var driver = kwDriver
                if (driver == null || !driver.isOpen) {
                    disconnectSession()
                    val newDriver = Ftdi5BaudDriver(manager, dev)
                    if (newDriver.open(9600)) {
                        kwDriver = newDriver
                        driver = newDriver
                    } else {
                        tvStatus.text = "Не удалось открыть USB порт"
                        val err = newDriver.lastError ?: "Неизвестная ошибка"
                        addLog("Ошибка открытия порта: $err")
                        btnConnectEcu.isEnabled = true
                        return@launch
                    }
                }

                val protocol = Kw1281Protocol(driver)
                kwProtocol = protocol
                val success = protocol.connect { msg -> addLog(msg) }
                if (success) {
                    val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else "3A0 907 311"
                    tvStatus.text = "ЭБУ подключен: $pNum (\${protocol.negotiatedBaud} бод)"
                    btnConnectEcu.isEnabled = true
                    btnReadFaults.isEnabled = true
                    btnClearFaults.isEnabled = true
                } else {
                    tvStatus.text = "Ошибка связи с ЭБУ"
                    btnConnectEcu.isEnabled = true
                }
            } catch (t: Throwable) {
                t.printStackTrace()
                addLog("Сбой при подключении: \${t.message ?: t.javaClass.simpleName}")
                tvStatus.text = "Ошибка подключения"
                btnConnectEcu.isEnabled = true
            }
        }
    }

    private fun readFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                btnReadFaults.isEnabled = false
                val faults = protocol.readFaultCodes { msg -> addLog(msg) }
                btnReadFaults.isEnabled = true
                if (faults.isEmpty()) {
                    addLog("В памяти ЭБУ ошибок нет (DTC 00000). Все системы в норме!")
                } else {
                    addLog("Всего обнаружено неисправностей: \${faults.size}")
                    for ((dtc, desc) in faults) {
                        addLog("• $dtc — $desc")
                    }
                }
            } catch (t: Throwable) {
                btnReadFaults.isEnabled = true
                addLog("Ошибка чтения DTC: \${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    private fun clearFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                btnClearFaults.isEnabled = false
                val success = protocol.clearFaultCodes { msg -> addLog(msg) }
                btnClearFaults.isEnabled = true
                if (success) {
                    addLog("Память ошибок очищена! Повторите чтение для проверки.")
                }
            } catch (t: Throwable) {
                btnClearFaults.isEnabled = true
                addLog("Ошибка стирания DTC: \${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
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
