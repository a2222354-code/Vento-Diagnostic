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
          distribution: 'temurin'
          cache: gradle

      - name: 3. Установка Gradle 8.4
        uses: gradle/actions/setup-gradle@v3
        with:
          gradle-version: '8.4'

      - name: 4. Компиляция Debug APK
        run: |
          if [ -d "android" ]; then
            cd android
          fi
          gradle assembleDebug --stacktrace --no-daemon

      - name: 5. Выгрузка готового APK в артефакты
        uses: actions/upload-artifact@v4
        with:
          name: kw1281-vento-debug-apk
          path: app/build/outputs/apk/debug/app-debug.apk
          retention-days: 14
`
  },
  {
    path: 'app/src/main/java/com/vag/kw1281/Ftdi5BaudDriver.kt',
    filename: 'Ftdi5BaudDriver.kt',
    language: 'kotlin',
    description: 'Драйвер 5-бодовой инициализации KW1281 на FTDI FT232 через Break и BitBang',
    content: `package com.vag.kw1281

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Решение проблемы 5 бод на FTDI FT232:
 * Стандартный драйвер FTDI не поддерживает скорость ниже 183 бод.
 * Инициализация ЭБУ адресом 0x01 (Двигатель) выполняется через управление
 * линией передачи (UART BREAK) либо аппаратный BitBang режим FTDI.
 * Длительность каждого бита на 5 бод = 200 мс.
 */
class Ftdi5BaudDriver(
    private val usbManager: UsbManager,
    private val device: UsbDevice
) {
    private var connection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null

    companion object {
        private const val BIT_TIME_MS = 200L // 5 бод = 200 мс на 1 бит
    }

    /**
     * Открытие устройства и подготовка порта
     */
    suspend fun open(): Boolean = withContext(Dispatchers.IO) {
        connection = usbManager.openDevice(device) ?: return@withContext false
        val driver = FtdiSerialDriver(device)
        port = driver.ports[0]
        port?.open(connection)
        
        // Базовая настройка порта перед 5-бод посылкой
        port?.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
        true
    }

    /**
     * Посылка адреса блока 0x01 (Двигатель) на скорости 5 бод.
     * Структура посылки (10 бит по 200 мс):
     * 1. Start bit: Space (0)
     * 2. 7 бит данных LSB first для 0x01 (1, 0, 0, 0, 0, 0, 0)
     * 3. 1 бит нечетности Odd Parity (для 0x01 = 0)
     * 4. 1 Стоп-бит: Mark (1)
     */
    suspend fun send5BaudInitAddress(address: Int = 0x01, onLog: (String) -> Unit): Boolean = withContext(Dispatchers.IO) {
        val p = port ?: return@withContext false
        onLog("Начало 5-бодовой инициализации адреса 0x%02X...".format(address))

        try {
            // 1. Старт-бит: Space (0) -> Break = true (200 мс)
            p.setBreak(true)
            Thread.sleep(BIT_TIME_MS)

            // 2. 7 бит данных LSB first
            var onesCount = 0
            for (i in 0 until 7) {
                val bit = (address shr i) and 0x01
                if (bit == 1) {
                    onesCount++
                    // Mark (1) -> Break = false
                    p.setBreak(false)
                } else {
                    // Space (0) -> Break = true
                    p.setBreak(true)
                }
                Thread.sleep(BIT_TIME_MS)
            }

            // 3. Бит четности (Odd Parity):
            // Если кол-во единиц уже нечетное (1 для 0x01), бит = 0 (Break = true)
            val parityBit = if (onesCount % 2 == 1) 0 else 1
            p.setBreak(parityBit == 0)
            Thread.sleep(BIT_TIME_MS)

            // 4. Стоп-бит: Mark (1) -> Break = false
            p.setBreak(false)
            Thread.sleep(BIT_TIME_MS)

            onLog("5-бодовая посылка завершена (2000 мс). Переключение на 9600 бод...")

            // 5. Переключение в рабочий режим 9600 бод 8N1
            p.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            true
        } catch (e: Exception) {
            onLog("Ошибка 5-бодовой посылки: \${e.message}")
            false
        }
    }

    suspend fun readBytes(buffer: ByteArray, timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        port?.read(buffer, timeoutMs) ?: -1
    }

    suspend fun writeBytes(data: ByteArray, timeoutMs: Int) = withContext(Dispatchers.IO) {
        port?.write(data, timeoutMs)
    }

    fun close() {
        try {
            port?.close()
            connection?.close()
        } catch (_: Exception) {}
    }
}
`
  },
  {
    path: 'app/src/main/java/com/vag/kw1281/Kw1281Protocol.kt',
    filename: 'Kw1281Protocol.kt',
    language: 'kotlin',
    description: 'Машина состояний протокола KW1281 (Синхронизация 0x55, Keybytes, Title, DTC)',
    content: `package com.vag.kw1281

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

    /**
     * Выполнение начального рукопожатия KW1281:
     * 1. 5 бод посылка адреса 0x01
     * 2. Приём синхробайта 0x55
     * 3. Приём KB1 и KB2 (обычно 0x01 и 0x8A)
     * 4. Отправка инвертированного KB2 (~KB2)
     * 5. Чтение блоков идентификации ЭБУ
     */
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
`
  },
  {
    path: 'app/src/main/java/com/vag/kw1281/MainActivity.kt',
    filename: 'MainActivity.kt',
    language: 'kotlin',
    description: 'Главный экран Android-приложения с UI на Jetpack Compose',
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
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private lateinit var usbManager: UsbManager
    private val ACTION_USB_PERMISSION = "com.vag.kw1281.USB_PERMISSION"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        usbManager = getSystemService(Context.USB_SERVICE) as UsbManager

        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                Kw1281AppScreen(
                    usbManager = usbManager,
                    onRequestPermission = { device -> requestUsbPermission(device) }
                )
            }
        }
    }

    private fun requestUsbPermission(device: UsbDevice) {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            PendingIntent.FLAG_MUTABLE
        } else {
            0
        }
        val permissionIntent = PendingIntent.getBroadcast(
            this, 0, Intent(ACTION_USB_PERMISSION), flags
        )
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (ACTION_USB_PERMISSION == intent?.action) {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    // Разрешение получено
                }
            }
        }, filter, Context.RECEIVER_NOT_EXPORTED)

        usbManager.requestPermission(device, permissionIntent)
    }
}

@Composable
fun Kw1281AppScreen(
    usbManager: UsbManager,
    onRequestPermission: (UsbDevice) -> Unit
) {
    val coroutineScope = rememberCoroutineScope()
    var statusText by remember { mutableStateOf("Ожидание подключения KKL адаптера...") }
    var logs by remember { mutableStateOf(listOf<String>()) }
    var foundDevice by remember { mutableStateOf<UsbDevice?>(null) }
    var isConnected by remember { mutableStateOf(false) }

    fun addLog(msg: String) {
        logs = logs + msg
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF090D16))
            .padding(16.dp)
    ) {
        Text(
            text = "VAG KW1281 DIAGNOSTIC",
            fontSize = 20.sp,
            color = Color(0xFF38BDF8),
            fontFamily = FontFamily.Monospace
        )
        Text(
            text = "VW Vento / Golf 3 (Mono-Motronic 1.2.3, 3A0 907 311)",
            fontSize = 12.sp,
            color = Color.Gray
        )

        Spacer(modifier = Modifier.height(16.dp))

        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B))
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text("Статус: $statusText", color = Color.White)
                foundDevice?.let {
                    Text("Устройство: VID 0x%04X, PID 0x%04X".format(it.vendorId, it.productId), color = Color(0xFF38BDF8))
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    val deviceList = usbManager.deviceList
                    val ftdi = deviceList.values.firstOrNull { it.vendorId == 0x0403 }
                    if (ftdi != null) {
                        foundDevice = ftdi
                        statusText = "Адаптер FT232 обнаружен!"
                        onRequestPermission(ftdi)
                        addLog("FTDI FT232R найден: VID=0x0403, PID=0x6001")
                    } else {
                        statusText = "FT232 не найден. Подключите OTG кабель."
                        addLog("Ошибка: USB KKL адаптер не подключен к телефону")
                    }
                },
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF0284C7))
            ) {
                Text("Найти USB KKL")
            }

            foundDevice?.let { dev ->
                Button(
                    onClick = {
                        coroutineScope.launch {
                            val driver = Ftdi5BaudDriver(usbManager, dev)
                            if (driver.open()) {
                                isConnected = true
                                statusText = "Инициализация 5 бод..."
                                val protocol = Kw1281Protocol(driver)
                                val success = protocol.connect { msg -> addLog(msg) }
                                if (success) {
                                    statusText = "ЭБУ подключен: \${protocol.ecuPartNumber}"
                                }
                            }
                        }
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF10B981))
                ) {
                    Text("Подключить к ЭБУ")
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
        Text("Журнал обмена:", color = Color.LightGray, fontSize = 14.sp)

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .background(Color(0xFF020617))
                .padding(8.dp)
        ) {
            items(logs) { log ->
                Text(
                    text = log,
                    color = Color(0xFF34D399),
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace
                )
            }
        }
    }
}
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
        android:label="KW1281 Diag"
        android:roundIcon="@mipmap/ic_launcher_round"
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
    description: 'Сборочный скрипт модуля с библиотекой usb-serial-for-android и Jetpack Compose',
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
    buildFeatures {
        compose = true
    }
    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.11"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.2")
    implementation("androidx.activity:activity-compose:1.9.0")
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.material3:material3")
    
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

  return await zip.generateAsync({ type: 'blob' });
}
