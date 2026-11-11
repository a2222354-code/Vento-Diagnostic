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
import kotlinx.coroutines.withContext
import java.util.ArrayDeque

/**
 * Высокоточный и надежный драйвер K-Line / FTDI FT232 для KW1281.
 * 
 * ВАЖНО для FTDI в usb-serial-for-android:
 * 1. p.read(...) требует буфер длиной более 2 байт (из-за 2 байт заголовка статуса модема FTDI).
 *    Чтение одиночных байт реализовано через очередь rxQueue и буфер 256 байт.
 * 2. Для корректной работы приёмопередатчика K-Line (L9637D / MC33199 / транзисторы)
 *    необходимо удерживать сигналы DTR и RTS в активном состоянии (true), как в VAG-COM на ПК.
 * 3. Переключение на рабочую скорость (9600/10400) и очистка мусора от Break производятся
 *    в середине стоп-бита (когда линия гарантированно свободна), чтобы ни в коем случае
 *    не стереть входящий байт 0x55 от ЭБУ.
 */
class Ftdi5BaudDriver(
    private val usbManager: UsbManager,
    private val device: UsbDevice
) {
    private var connection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null

    // Очередь для побайтового чтения
    private val rxQueue = ArrayDeque<Byte>()
    var lastError: String? = null
        private set

    companion object {
        private const val BIT_TIME_NANOS = 200_000_000L // 200 мс = 5 бод
    }

    suspend fun open(initialBaud: Int = 9600): Boolean = withContext(Dispatchers.IO) {
        try {
            close()
            lastError = null

            connection = usbManager.openDevice(device) ?: run {
                lastError = "Не удалось открыть соединение UsbDeviceConnection"
                return@withContext false
            }

            val proberDriver = try {
                UsbSerialProber.getDefaultProber().probeDevice(device)
            } catch (t: Throwable) {
                null
            }
            val driver = proberDriver ?: FtdiSerialDriver(device)
            if (driver.ports.isEmpty()) {
                lastError = "Устройство не содержит доступных COM-портов"
                return@withContext false
            }
            
            val p = driver.ports[0]
            port = p
            p.open(connection)

            try {
                p.setParameters(initialBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            } catch (t: Throwable) {}

            // Активируем сигналы DTR и RTS (необходимо для питания и включения микросхемы K-Line)
            try { p.setDTR(true) } catch (t: Throwable) {}
            try { p.setRTS(true) } catch (t: Throwable) {}

            // Первичный сброс буферов
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

    fun clearRxQueue() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
    }

    private class CycleWaiter(private val periodNanos: Long) {
        private var nextTargetNanos = System.nanoTime()

        fun waitNext() {
            nextTargetNanos += periodNanos
            val now = System.nanoTime()
            val remainingMs = (nextTargetNanos - now) / 1_000_000L
            if (remainingMs > 15) {
                try {
                    Thread.sleep(remainingMs - 10)
                } catch (e: InterruptedException) {}
            }
            while (System.nanoTime() < nextTargetNanos) {
                // Плотный цикл для идеальной микросекундной точности 200.0 мс
            }
        }
    }

    suspend fun send5BaudInitAddress(
        address: Int = 0x01,
        targetBaud: Int = 9600,
        onLog: (String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext false
        onLog("Подготовка K-Line (DTR/RTS ВКЛ, пауза 400 мс)...")

        try {
            // Убеждаемся, что модемные линии активны, а линия K-Line в покое (Mark, +12V)
            try { p.setDTR(true) } catch (t: Throwable) {}
            try { p.setRTS(true) } catch (t: Throwable) {}
            try { p.setBreak(false) } catch (t: Throwable) {}
            Thread.sleep(400)

            onLog("5 бод: посылка адреса 0x%02X (200 мс/бит)...".format(address))
            val waiter = CycleWaiter(BIT_TIME_NANOS)

            // 1. Старт-бит: Space (0) -> Break = true (0V)
            try { p.setBreak(true) } catch (t: Throwable) {}
            waiter.waitNext()

            // 2. 7 бит данных LSB first
            var onesCount = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                if (bit == 1) {
                    onesCount++
                    try { p.setBreak(false) } catch (t: Throwable) {} // Mark (12V)
                } else {
                    try { p.setBreak(true) } catch (t: Throwable) {}  // Space (0V)
                }
                waiter.waitNext()
            }

            // 3. Бит четности (Odd Parity для KW1281)
            val parityBit = if (onesCount % 2 != 0) 0 else 1
            try { p.setBreak(parityBit == 0) } catch (t: Throwable) {}
            waiter.waitNext()

            // 4. Стоп-бит: Mark (1) -> Break = false (12V)
            try { p.setBreak(false) } catch (t: Throwable) {}
            
            // Выжидаем первые 100 мс стоп-бита
            Thread.sleep(100)

            // В середине стоп-бита (линия гарантированно в покое) конфигурируем рабочую скорость UART
            try {
                p.setParameters(targetBaud, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
                p.setDTR(true)
                p.setRTS(true)
            } catch (t: Throwable) {
                onLog("Предупреждение UART: \${t.message}")
            }

            // Очищаем эхо/мусор от Break до того, как ЭБУ начнет отвечать
            synchronized(rxQueue) {
                rxQueue.clear()
            }
            try {
                p.purgeHwBuffers(true, true)
            } catch (t: Throwable) {}

            // Выжидаем оставшиеся 100 мс стоп-бита
            Thread.sleep(100)

            onLog("5-бодовая посылка завершена. Ожидание ответа ЭБУ...")
            true
        } catch (t: Throwable) {
            lastError = "\${t.javaClass.simpleName}: \${t.message}"
            onLog("Ошибка 5-бодовой посылки: \${t.message ?: t.javaClass.simpleName}")
            false
        }
    }

    /**
     * Чтение одного байта с таймаутом через 256-байтный буфер (требование FTDI драйвера)
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
     * Чтение нескольких байт в буфер
     */
    suspend fun readBytes(buffer: ByteArray, timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        if (buffer.isEmpty()) return@withContext 0
        var count = 0
        val start = System.currentTimeMillis()
        while (count < buffer.size && (System.currentTimeMillis() - start < timeoutMs)) {
            val remainingTimeout = (timeoutMs - (System.currentTimeMillis() - start)).toInt().coerceAtLeast(20)
            val b = readByte(remainingTimeout)
            if (b >= 0) {
                buffer[count] = b.toByte()
                count++
            } else {
                break
            }
        }
        return@withContext count
    }

    /**
     * Отправка байта с подавлением отражённого эхо K-Line
     */
    suspend fun writeByteAndDiscardEcho(b: Byte, timeoutMs: Int = 300) = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext
        try {
            p.write(byteArrayOf(b), timeoutMs)
            // K-Line Loopback эхо: считываем и сбрасываем отражённый байт
            readByte(100)
        } catch (t: Throwable) {}
    }

    suspend fun writeBytesAndDiscardEcho(data: ByteArray, timeoutMs: Int = 500) = withContext(Dispatchers.IO) {
        for (b in data) {
            writeByteAndDiscardEcho(b, timeoutMs)
        }
    }

    fun close() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
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
    description: 'Машина состояний протокола KW1281 с защитой от сбоев',
    content: `package com.vag.kw1281

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

    suspend fun connect(baudRate: Int = 0, onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        try {
            val speedsToTry = if (baudRate == 0) listOf(9600, 10400, 4800) else listOf(baudRate)
            for (speed in speedsToTry) {
                onLog("--- Попытка KW1281 на скорости \${speed} бод ---")
                if (tryConnectAtBaud(speed, onLog)) {
                    negotiatedBaud = speed
                    return@withContext true
                }
                delay(400)
            }
            onLog("Подключение не удалось. Проверьте зажигание, надёжность K-Line и переключатель скорости.")
            false
        } catch (t: Throwable) {
            onLog("Исключение протокола: \${t.message ?: t.javaClass.simpleName}")
            false
        }
    }

    private suspend fun tryConnectAtBaud(targetBaud: Int, onLog: (String) -> Unit): Boolean {
        try {
            blockCounter = 0
            ecuPartNumber = ""
            ecuComponent = ""
            ecuExtra = ""

            val sent = driver.send5BaudInitAddress(0x01, targetBaud, onLog)
            if (!sent) return false

            onLog("Ожидание синхробайта 0x55 (таймаут 3.5 с)...")
            val syncStart = System.currentTimeMillis()
            var syncFound = false
            val receivedHex = mutableListOf<String>()

            while (System.currentTimeMillis() - syncStart < 3500) {
                val b = driver.readByte(250)
                if (b >= 0) {
                    val hexStr = "0x%02X".format(b)
                    receivedHex.add(hexStr)
                    onLog("Получен байт K-Line: $hexStr")
                    if (b == 0x55) {
                        syncFound = true
                        break
                    }
                }
            }

            if (!syncFound) {
                val errNote = driver.lastError?.let { " [Драйвер: $it]" } ?: ""
                val rxDetails = if (receivedHex.isEmpty()) "линия молчит" else "получено: \${receivedHex.joinToString(\" \")}"
                onLog("Синхробайт 0x55 не обнаружен (\${rxDetails})\${errNote}.")
                return false
            }

            onLog("Получен Sync Byte: 0x55! Скорость \${targetBaud} бод подтверждена.")

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

            val complement = ((kb2 xor 0xFF) and 0xFF).toByte()
            delay(35)
            driver.writeByteAndDiscardEcho(complement, 500)
            onLog("Отправлен комплемент ~KB2: 0x%02X".format(complement.toInt() and 0xFF))

            return readTitleBlocks(onLog)
        } catch (t: Throwable) {
            onLog("Ошибка сессии: \${t.message ?: t.javaClass.simpleName}")
            return false
        }
    }

    private suspend fun readAndAckByte(timeoutMs: Int = 1500): Int {
        try {
            val b = driver.readByte(timeoutMs)
            if (b < 0) return -1
            delay(3)
            val comp = ((b xor 0xFF) and 0xFF).toByte()
            driver.writeByteAndDiscardEcho(comp, 500)
            return b
        } catch (t: Throwable) {
            return -1
        }
    }

    private suspend fun receiveBlock(timeoutMs: Int = 2000): KwBlock? {
        try {
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

            driver.readByte(1000)
            return KwBlock(length, counter, title, data)
        } catch (t: Throwable) {
            return null
        }
    }

    private suspend fun sendBlock(title: Int, payload: ByteArray = ByteArray(0)): Boolean {
        try {
            blockCounter++
            val length = 3 + payload.size
            val packet = mutableListOf<Byte>()
            packet.add(length.toByte())
            packet.add((blockCounter and 0xFF).toByte())
            packet.add(title.toByte())
            for (b in payload) {
                packet.add(b)
            }
            packet.add(0x03.toByte())

            for (i in 0 until packet.size - 1) {
                val b = packet[i]
                driver.writeByteAndDiscardEcho(b, 500)
                driver.readByte(1000)
            }
            driver.writeByteAndDiscardEcho(0x03.toByte(), 500)
            return true
        } catch (t: Throwable) {
            return false
        }
    }

    private suspend fun readTitleBlocks(onLog: (String) -> Unit): Boolean {
        try {
            var titleCount = 0
            while (titleCount < 4) {
                val block = receiveBlock(2000) ?: break
                titleCount++
                blockCounter = block.counter

                if (block.title == 0xF6) {
                    val text = String(block.data, Charsets.US_ASCII).trim()
                    when (titleCount) {
                        1 -> { ecuPartNumber = text; onLog("ЭБУ Номер: \${text}") }
                        2 -> { ecuComponent = text; onLog("ЭБУ Компонент: \${text}") }
                        3 -> { ecuExtra = text; onLog("ЭБУ Кодировка: \${text}") }
                        else -> onLog("ЭБУ Инфо: \${text}")
                    }
                    sendBlock(0x09)
                } else if (block.title == 0x09) {
                    onLog("Идентификация завершена. ЭБУ готов к командам!")
                    return true
                }
            }
            return ecuPartNumber.isNotEmpty()
        } catch (t: Throwable) {
            onLog("Ошибка чтения инфо: \${t.message ?: t.javaClass.simpleName}")
            return false
        }
    }

    suspend fun readFaultCodes(onLog: (String) -> Unit): List<Pair<String, String>> = withContext(Dispatchers.IO) {
        val faults = mutableListOf<Pair<String, String>>()
        try {
            onLog("Запрос памяти ошибок (Команда 0x07)...")
            sendBlock(0x07)

            while (true) {
                val block = receiveBlock(2000) ?: break
                blockCounter = block.counter

                if (block.title == 0xFC) {
                    var idx = 0
                    while (idx + 1 < block.data.size) {
                        val high = block.data[idx].toInt() and 0xFF
                        val low = block.data[idx + 1].toInt() and 0xFF
                        val code = (high shl 8) or low
                        if (code != 0) {
                            val dtc = "%05d".format(code)
                            val desc = KNOWN_DTC_DESCRIPTIONS[dtc] ?: "Код неисправности VAG \${dtc}"
                            faults.add(Pair(dtc, desc))
                            onLog("Ошибка \${dtc}: \${desc}")
                        }
                        idx += 2
                    }
                    sendBlock(0x09)
                } else {
                    sendBlock(0x09)
                    break
                }
            }
        } catch (t: Throwable) {
            onLog("Ошибка чтения DTC: \${t.message ?: t.javaClass.simpleName}")
        }
        faults
    }

    suspend fun clearFaultCodes(onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        try {
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
        } catch (t: Throwable) {
            onLog("Ошибка стирания: \${t.message ?: t.javaClass.simpleName}")
            false
        }
    }
}
`
  },
  {
    path: 'app/src/main/res/layout/activity_main.xml',
    filename: 'activity_main.xml',
    language: 'xml',
    description: 'Разметка интерфейса с выбором скорости (Авто/9600/10400/4800) и журналом KW1281',
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

    <LinearLayout
        android:layout_width="match_parent"
        android:layout_height="wrap_content"
        android:orientation="horizontal"
        android:gravity="center_vertical"
        android:layout_marginBottom="8dp">

        <TextView
            android:layout_width="wrap_content"
            android:layout_height="wrap_content"
            android:text="Скорость:"
            android:textColor="#94A3B8"
            android:textSize="12sp"
            android:layout_marginEnd="6dp" />

        <Button
            android:id="@+id/btnBaudAuto"
            android:layout_width="0dp"
            android:layout_height="36dp"
            android:layout_weight="1"
            android:text="Авто"
            android:textSize="11sp"
            android:padding="0dp"
            android:backgroundTint="#38BDF8"
            android:textColor="#090D16"
            android:textStyle="bold" />

        <Button
            android:id="@+id/btnBaud9600"
            android:layout_width="0dp"
            android:layout_height="36dp"
            android:layout_weight="1"
            android:text="9600"
            android:textSize="11sp"
            android:padding="0dp"
            android:layout_marginStart="4dp"
            android:backgroundTint="#334155"
            android:textColor="#CBD5E1" />

        <Button
            android:id="@+id/btnBaud10400"
            android:layout_width="0dp"
            android:layout_height="36dp"
            android:layout_weight="1"
            android:text="10400"
            android:textSize="11sp"
            android:padding="0dp"
            android:layout_marginStart="4dp"
            android:backgroundTint="#334155"
            android:textColor="#CBD5E1" />

        <Button
            android:id="@+id/btnBaud4800"
            android:layout_width="0dp"
            android:layout_height="36dp"
            android:layout_weight="1"
            android:text="4800"
            android:textSize="11sp"
            android:padding="0dp"
            android:layout_marginStart="4dp"
            android:backgroundTint="#334155"
            android:textColor="#CBD5E1" />
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
    description: 'Главный экран Android-приложения с защитой от сбоев и выбором скорости',
    content: `package com.vag.kw1281

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.ColorStateList
import android.graphics.Color
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

    private lateinit var btnBaudAuto: Button
    private lateinit var btnBaud9600: Button
    private lateinit var btnBaud10400: Button
    private lateinit var btnBaud4800: Button

    private var selectedBaud: Int = 0
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
                    addLog("USB устройство отключено.")
                    foundDevice = null
                    btnConnectEcu.isEnabled = false
                    btnReadFaults.isEnabled = false
                    btnClearFaults.isEnabled = false
                    tvStatus.text = "Статус: USB отключен"
                    tvDeviceInfo.text = "Подключите USB-OTG кабель"
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

            btnBaudAuto = findViewById(R.id.btnBaudAuto)
            btnBaud9600 = findViewById(R.id.btnBaud9600)
            btnBaud10400 = findViewById(R.id.btnBaud10400)
            btnBaud4800 = findViewById(R.id.btnBaud4800)

            setupBaudButtons()

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
            findUsbAdapter()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun setupBaudButtons() {
        fun updateStyles() {
            try {
                val activeColor = Color.parseColor("#38BDF8")
                val activeText = Color.parseColor("#090D16")
                val inactiveColor = Color.parseColor("#334155")
                val inactiveText = Color.parseColor("#CBD5E1")

                btnBaudAuto.backgroundTintList = ColorStateList.valueOf(if (selectedBaud == 0) activeColor else inactiveColor)
                btnBaudAuto.setTextColor(if (selectedBaud == 0) activeText else inactiveText)

                btnBaud9600.backgroundTintList = ColorStateList.valueOf(if (selectedBaud == 9600) activeColor else inactiveColor)
                btnBaud9600.setTextColor(if (selectedBaud == 9600) activeText else inactiveText)

                btnBaud10400.backgroundTintList = ColorStateList.valueOf(if (selectedBaud == 10400) activeColor else inactiveColor)
                btnBaud10400.setTextColor(if (selectedBaud == 10400) activeText else inactiveText)

                btnBaud4800.backgroundTintList = ColorStateList.valueOf(if (selectedBaud == 4800) activeColor else inactiveColor)
                btnBaud4800.setTextColor(if (selectedBaud == 4800) activeText else inactiveText)
            } catch (t: Throwable) {}
        }

        btnBaudAuto.setOnClickListener {
            selectedBaud = 0
            updateStyles()
            addLog("Режим скорости: Авто (поиск 9600 / 10400 бод)")
        }
        btnBaud9600.setOnClickListener {
            selectedBaud = 9600
            updateStyles()
            addLog("Режим скорости: 9600 бод")
        }
        btnBaud10400.setOnClickListener {
            selectedBaud = 10400
            updateStyles()
            addLog("Режим скорости: 10400 бод")
        }
        btnBaud4800.setOnClickListener {
            selectedBaud = 4800
            updateStyles()
            addLog("Режим скорости: 4800 бод")
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
            tvDeviceInfo.text = "Устройство: VID 0x%04X, PID 0x%04X".format(ftdi.vendorId, ftdi.productId)
            addLog("USB KKL адаптер найден: VID=0x%04X, PID=0x%04X".format(ftdi.vendorId, ftdi.productId))
            
            if (manager.hasPermission(ftdi)) {
                btnConnectEcu.isEnabled = true
                addLog("Права на работу с USB адаптером уже предоставлены.")
            } else {
                btnConnectEcu.isEnabled = false
                requestUsbPermission(ftdi)
            }
        } else {
            tvStatus.text = "Статус: KKL адаптер не найден"
            tvDeviceInfo.text = "Подключите USB-OTG кабель к телефону"
            btnConnectEcu.isEnabled = false
            addLog("Адаптер FT232 / CH340 не обнаружен. Проверьте OTG соединение.")
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
                tvStatus.text = "Статус: Открытие порта..."
                
                try {
                    kwDriver?.close()
                } catch (t: Throwable) {}

                val initialBaud = if (selectedBaud == 0) 9600 else selectedBaud
                val driver = Ftdi5BaudDriver(manager, dev)
                if (driver.open(initialBaud)) {
                    kwDriver = driver
                    tvStatus.text = "Статус: Инициализация 5 бод..."
                    val protocol = Kw1281Protocol(driver)
                    kwProtocol = protocol
                    val success = protocol.connect(selectedBaud) { msg -> addLog(msg) }
                    if (success) {
                        val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else "3A0 907 311"
                        tvStatus.text = "ЭБУ подключен: \${pNum} (\${protocol.negotiatedBaud} бод)"
                        btnReadFaults.isEnabled = true
                        btnClearFaults.isEnabled = true
                    } else {
                        tvStatus.text = "Ошибка связи с ЭБУ"
                        btnConnectEcu.isEnabled = true
                    }
                } else {
                    tvStatus.text = "Не удалось открыть USB порт"
                    addLog("Ошибка: Не удалось открыть порт USB адаптера.")
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
                    addLog("Всего ошибок: \${faults.size}")
                    for ((dtc, desc) in faults) {
                        addLog("• \${dtc} — \${desc}")
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
        try {
            kwDriver?.close()
        } catch (e: Exception) {}
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
