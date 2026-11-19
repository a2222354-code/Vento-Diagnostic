package com.vag.kw1281

import android.app.Dialog
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.vag.kw1281.OscilloscopeView.SensorChannel
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

    // Отдельное окно измерений и осциллограф
    private var measuringDialog: Dialog? = null
    private val selectedScopeChannels = linkedSetOf(SensorChannel.RPM, SensorChannel.LAMBDA)
    private var isScopePanelVisible: Boolean = true

    private class MeasuringWindowViews(dialog: Dialog) {
        val tvStatus: TextView = dialog.findViewById(R.id.tvMeasStatus)
        val btnToggleScope: Button = dialog.findViewById(R.id.btnToggleScope)
        val btnClose: Button = dialog.findViewById(R.id.btnCloseMeas)
        val layoutScopePanel: LinearLayout = dialog.findViewById(R.id.layoutOscilloscopePanel)
        val tvScopeCount: TextView = dialog.findViewById(R.id.tvScopeCount)
        val btnScopeWindow: Button = dialog.findViewById(R.id.btnScopeWindow)
        val btnScopePause: Button = dialog.findViewById(R.id.btnScopePause)
        val btnScopeClear: Button = dialog.findViewById(R.id.btnScopeClear)
        val scopeView: OscilloscopeView = dialog.findViewById(R.id.oscilloscopeView)

        val tvRpm: TextView = dialog.findViewById(R.id.tvMeasRpm)
        val tvTemp: TextView = dialog.findViewById(R.id.tvMeasTemp)
        val tvLambda: TextView = dialog.findViewById(R.id.tvMeasLambda)
        val tvLambdaUnit: TextView = dialog.findViewById(R.id.tvMeasLambdaUnit)
        val tvThrottle: TextView = dialog.findViewById(R.id.tvMeasThrottle)
        val tvBattery: TextView = dialog.findViewById(R.id.tvMeasBattery)
        val tvInj: TextView = dialog.findViewById(R.id.tvMeasInj)
        val tvAirTemp: TextView = dialog.findViewById(R.id.tvMeasAirTemp)
        val tvTiming: TextView = dialog.findViewById(R.id.tvMeasTiming)
        val tvLoad: TextView = dialog.findViewById(R.id.tvMeasLoad)
        val tvIdleSwitch: TextView = dialog.findViewById(R.id.tvMeasIdleSwitch)
        val tvMode: TextView = dialog.findViewById(R.id.tvMeasMode)
        val tvRawGroups: TextView = dialog.findViewById(R.id.tvMeasRawGroups)

        val channelCards: Map<SensorChannel, Pair<LinearLayout, TextView>> = mapOf(
            SensorChannel.RPM to (dialog.findViewById<LinearLayout>(R.id.cardRpm) to dialog.findViewById<TextView>(R.id.tvBadgeRpm)),
            SensorChannel.COOLANT to (dialog.findViewById<LinearLayout>(R.id.cardTemp) to dialog.findViewById<TextView>(R.id.tvBadgeTemp)),
            SensorChannel.LAMBDA to (dialog.findViewById<LinearLayout>(R.id.cardLambda) to dialog.findViewById<TextView>(R.id.tvBadgeLambda)),
            SensorChannel.THROTTLE to (dialog.findViewById<LinearLayout>(R.id.cardThrottle) to dialog.findViewById<TextView>(R.id.tvBadgeThrottle)),
            SensorChannel.BATTERY to (dialog.findViewById<LinearLayout>(R.id.cardBattery) to dialog.findViewById<TextView>(R.id.tvBadgeBattery)),
            SensorChannel.INJECTION to (dialog.findViewById<LinearLayout>(R.id.cardInj) to dialog.findViewById<TextView>(R.id.tvBadgeInj)),
            SensorChannel.AIR_TEMP to (dialog.findViewById<LinearLayout>(R.id.cardAirTemp) to dialog.findViewById<TextView>(R.id.tvBadgeAirTemp)),
            SensorChannel.TIMING to (dialog.findViewById<LinearLayout>(R.id.cardTiming) to dialog.findViewById<TextView>(R.id.tvBadgeTiming)),
            SensorChannel.LOAD to (dialog.findViewById<LinearLayout>(R.id.cardLoad) to dialog.findViewById<TextView>(R.id.tvBadgeLoad)),
            SensorChannel.IDLE_SWITCH to (dialog.findViewById<LinearLayout>(R.id.cardIdleSwitch) to dialog.findViewById<TextView>(R.id.tvBadgeIdleSwitch))
        )
    }

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

    // Панель адаптации (Канал 00: 0x21 / 0x2A)
    private lateinit var layoutAdaptation: LinearLayout
    private lateinit var tvAdaptHint: TextView
    private lateinit var etAdaptValue: EditText
    private lateinit var btnAdaptRead: Button
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
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
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
            etAdaptValue = findViewById(R.id.etAdaptValue)
            btnAdaptRead = findViewById(R.id.btnAdaptRead)
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
            btnMeasuring.setOnClickListener {
                if (selectedEcuAddress == 0x25) refreshImmobilizerStatus() else toggleLiveMeasuring()
            }
            btnActuatorStart.setOnClickListener { startActuatorTest() }
            btnActuatorNext.setOnClickListener { nextActuatorTest() }
            btnActuatorStop.setOnClickListener { stopActuatorTest() }
            btnBasicSettings.setOnClickListener { toggleBasicSettings() }
            btnAdaptationOpen.setOnClickListener { toggleAdaptationPanel() }
            btnAdaptClose.setOnClickListener { layoutAdaptation.visibility = View.GONE }
            btnAdaptRead.setOnClickListener { performAdaptationRead() }
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

        if (addr == 0x01) {
            btnTabEngine.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0284C7"))
            btnTabEngine.setTextColor(Color.WHITE)
            btnTabImmo.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#334155"))
            btnTabImmo.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Bosch Mono-Motronic 1.2.3 (3A0 907 311)"
            layoutImmoStatus.visibility = View.GONE
            rowEngineDiagnostics.visibility = View.VISIBLE
            btnMeasuring.visibility = View.VISIBLE
            btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
            btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#8B5CF6"))
            btnActuatorStart.visibility = View.VISIBLE
            btnBasicSettings.visibility = View.VISIBLE
            btnAdaptationOpen.visibility = View.VISIBLE
            tvAdaptHint.text = "Канал 00: сброс выученных адаптаций смеси/РХХ (Сохранить 0)"
        } else {
            btnTabImmo.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0284C7"))
            btnTabImmo.setTextColor(Color.WHITE)
            btnTabEngine.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#334155"))
            btnTabEngine.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Иммобилайзер Wegfahrsicherung (1H0 953 257)"
            layoutImmoStatus.visibility = View.VISIBLE
            tvImmoKeyStatus.text = "• Транспондер ключа: Ожидание опроса..."
            tvImmoStartStatus.text = "• Разрешение пуска двигателя: Не проверено"
            tvImmoKeyCount.text = "• Ключей обучено в памяти: ---"
            rowEngineDiagnostics.visibility = View.VISIBLE
            btnMeasuring.visibility = View.VISIBLE
            btnMeasuring.text = "СТАТУС ИММО (08)"
            btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#8B5CF6"))
            btnActuatorStart.visibility = View.GONE
            btnBasicSettings.visibility = View.GONE
            btnAdaptationOpen.visibility = View.VISIBLE
            tvAdaptHint.text = "Канал 00: привязка ЭБУ двигателя к иммобилайзеру (введите 0 и Сохранить)"
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
                this, 0, Intent(ACTION_USB_PERMISSION).setPackage(packageName), flags
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
            setResultText("USB KKL адаптер не обнаружен.\n\n• Подключите кабель через USB-OTG переходник к телефону.\n• На некоторых смартфонах нужно включить «OTG-подключение» в настройках системы.")
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

                val blockName = if (selectedEcuAddress == 0x25) "Иммобилайзера (0x25)" else "ЭБУ Двигателя (0x01)"
                tvStatus.text = "Инициализация $blockName..."
                setResultText("Установка связи с $blockName (5 бод -> 9600 бод)...")

                disconnectSession()
                val newDriver = Ftdi5BaudDriver(manager, dev)
                if (!newDriver.open(9600)) {
                    tvStatus.text = "Ошибка открытия USB порта"
                    setResultText("Не удалось открыть USB порт: ${newDriver.lastError ?: "проверьте кабель"}")
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
                    tvBaudBadge.text = "${protocol.negotiatedBaud} бод"
                    btnConnectEcu.isEnabled = true
                    updateConnectButtonState(connected = true)
                    setDiagnosticButtonsEnabled(true)

                    if (selectedEcuAddress == 0x25) {
                        checkImmobilizerStatus(protocol)
                    } else {
                        setResultText("Связь с ЭБУ Двигателя установлена!\n" +
                                "• Номер VAG: ${protocol.ecuPartNumber}\n" +
                                "• Компонент: ${protocol.ecuComponent}\n" +
                                "• Кодировка: ${protocol.ecuExtra}\n\n" +
                                "Доступны: Ошибки (07), Измерения (08), Тест исполнителей (04), Базовые (УОЗ 6°) и Адаптация (10).")
                    }
                } else {
                    disconnectSession()
                    tvStatus.text = "Нет ответа от блока"
                    setResultText("Блок $blockName не отвечает на запрос инициализации.\n" +
                            "• Проверьте, включено ли зажигание (приборная панель горит).\n" +
                            "• Проверьте питание +12В на KKL адаптере (горит светодиод на шнурке) и контакт K-Line.")
                    btnConnectEcu.isEnabled = true
                    updateConnectButtonState(connected = false)
                }
            } catch (t: Throwable) {
                t.printStackTrace()
                disconnectSession()
                tvStatus.text = "Сбой подключения"
                setResultText("Сбой при подключении: ${t.message ?: t.javaClass.simpleName}")
                btnConnectEcu.isEnabled = true
                updateConnectButtonState(connected = false)
            }
        }
    }

    private fun refreshImmobilizerStatus() {
        val protocol = kwProtocol ?: run {
            setResultText("Сначала подключитесь к иммобилайзеру.")
            return
        }
        lifecycleScope.launch {
            btnMeasuring.isEnabled = false
            setResultText("Опрос состояния иммобилайзера и ключей (Группа 001 / 002)...")
            checkImmobilizerStatus(protocol)
            btnMeasuring.isEnabled = true
        }
    }

    private suspend fun checkImmobilizerStatus(protocol: Kw1281Protocol) {
        val status = protocol.readImmobilizerStatus { }
        if (status.errorMessage == null) {
            tvImmoKeyStatus.text = "• Транспондер ключа: ${if (status.keyAuthorized) "✅ Распознан (ID33 OK)" else "❌ ОШИБКА (Чип не прочитан)"}"
            tvImmoStartStatus.text = "• Разрешение пуска двигателя: ${if (status.startPermitted) "✅ РАЗРЕШЁН" else "❌ ЗАБЛОКИРОВАН (заглохнет через 1 сек)"}"
            tvImmoKeyCount.text = "• Ключей обучено в памяти: ${status.keyCount} шт."

            setResultText("Блок иммобилайзера ${protocol.ecuPartNumber.ifEmpty { "1H0 953 257" }} подключен!\n\n" +
                    "ДИАГНОСТИКА КЛЮЧА И СИСТЕМЫ ПУСКА:\n" +
                    "• Разрешение запуска: ${if (status.startPermitted) "РАЗРЕШЕНО (ЭБУ не блокируется)" else "ЗАПРЕЩЕНО (Блокировка мотора)"}\n" +
                    "• Ответ ЭБУ двигателя: ${if (status.ecuResponds) "Есть связь по W-Line" else "Нет связи с моторным ЭБУ"}\n" +
                    "• Транспондер чипа: ${if (status.keyAuthorized) "Авторизован" else "Не авторизован / Слабый сигнал катушки"}\n" +
                    "• Ключей прописано: ${status.keyCount} шт.\n" +
                    (if (status.rawSummary.isNotEmpty()) "• Данные группы 001: ${status.rawSummary}\n\n" else "\n") +
                    "Для синхронизации ЭБУ с иммобилайзером откройте «АДАПТАЦИЯ (10)» → Канал 00 → «СОХРАНИТЬ» (значение 0).")
        } else {
            tvImmoKeyStatus.text = "• Транспондер ключа: ⚠️ Не прочитан"
            tvImmoStartStatus.text = "• Разрешение пуска двигателя: ⚠️ ${status.errorMessage}"
            tvImmoKeyCount.text = "• Ключей обучено в памяти: ---"

            setResultText("Иммобилайзер подключен (${protocol.ecuPartNumber.ifEmpty { "1H0 953 257" }}).\n\n" +
                    "⚠️ Не удалось прочитать статус ключей (Группа 001):\n" +
                    "Причина: ${status.errorMessage}\n" +
                    (if (status.rawSummary.isNotEmpty()) "Ответ блока: ${status.rawSummary}\n\n" else "\n") +
                    "Нажмите «СТАТУС ИММО (08)» для повторного опроса или «ОШИБКИ (07)».")
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
                sb.append("РЕЗУЛЬТАТЫ ОПРОСА ПАМЯТИ НЕИСПРАВНОСТЕЙ:\n")
                sb.append("Блок: ").append(blockTitle).append("\n\n")

                if (faults.isEmpty()) {
                    sb.append("✅ В памяти ошибок нет (DTC 00000).\n")
                    sb.append("Все электрические цепи и датчики в пределах нормы.")
                } else {
                    sb.append("⚠️ ОБНАРУЖЕНО НЕИСПРАВНОСТЕЙ: ").append(faults.size).append("\n\n")
                    for (f in faults) {
                        sb.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
                        sb.append("КОД: ").append(f.code).append(" — ").append(f.component).append("\n")
                        sb.append("Статус: ").append(f.statusText).append("\n")
                        sb.append("Причина: ").append(f.cause).append("\n")
                        sb.append("Совет: ").append(f.remedy).append("\n")
                        if (f.isNormalWhenStopped) {
                            sb.append("ℹ️ ПРИМЕЧАНИЕ: На незаведённом моторе эта ошибка является нормой для Mono-Motronic 1.2.3!\n")
                        }
                    }
                    sb.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
                }
                setResultText(sb.toString())
            } catch (t: Throwable) {
                btnReadFaults.isEnabled = true
                setResultText("Ошибка чтения памяти неисправностей: ${t.message}")
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
                    setResultText("✅ Память кодов неисправностей успешно очищена!\n" +
                            "Нажмите «ОШИБКИ (07)» для контрольной проверки.")
                } else {
                    setResultText("Не удалось выполнить команду стирания ошибок.")
                }
            } catch (t: Throwable) {
                btnClearFaults.isEnabled = true
                setResultText("Ошибка стирания ошибок: ${t.message}")
            }
        }
    }

    private fun toggleLiveMeasuring() {
        if (measuringDialog?.isShowing == true || liveStreamJob != null) {
            stopLiveStream()
            setResultText("Окно измерений закрыто. Связь с ЭБУ активна.")
            return
        }

        val protocol = kwProtocol ?: run {
            setResultText("Сначала подключитесь к ЭБУ.")
            return
        }

        stopBasicSettingsStream()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = View.GONE

        val dialog = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setContentView(R.layout.dialog_measuring)
        dialog.window?.setLayout(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT
        )
        measuringDialog = dialog

        val views = MeasuringWindowViews(dialog)
        views.scopeView.setActiveChannels(selectedScopeChannels)
        updateScopeHeaderAndCards(views)

        views.btnToggleScope.setOnClickListener {
            isScopePanelVisible = !isScopePanelVisible
            updateScopeHeaderAndCards(views)
        }

        views.btnScopeWindow.setOnClickListener {
            val nextWindow = when (views.scopeView.getTimeWindowSeconds()) {
                15 -> 30_000L
                30 -> 60_000L
                else -> 15_000L
            }
            views.scopeView.setTimeWindowMs(nextWindow)
            views.btnScopeWindow.text = "${nextWindow / 1000L}с"
        }

        views.btnScopePause.setOnClickListener {
            val paused = !views.scopeView.isPausedState()
            views.scopeView.setPaused(paused)
            views.btnScopePause.text = if (paused) "ПУСК" else "ПАУЗА"
            views.btnScopePause.backgroundTintList = ColorStateList.valueOf(
                Color.parseColor(if (paused) "#D97706" else "#334155")
            )
        }

        views.btnScopeClear.setOnClickListener {
            views.scopeView.clearSamples()
        }

        for ((channel, pair) in views.channelCards) {
            val (card, _) = pair
            card.setOnClickListener {
                if (selectedScopeChannels.contains(channel)) {
                    selectedScopeChannels.remove(channel)
                } else {
                    selectedScopeChannels.add(channel)
                    if (!isScopePanelVisible) {
                        isScopePanelVisible = true
                    }
                }
                views.scopeView.setActiveChannels(selectedScopeChannels)
                updateScopeHeaderAndCards(views)
            }
        }

        var closedByDismiss = false
        views.btnClose.setOnClickListener {
            dialog.dismiss()
        }
        dialog.setOnDismissListener {
            if (!closedByDismiss) {
                closedByDismiss = true
                measuringDialog = null
                cancelLiveStreamJobOnly()
                setResultText("Окно измерений закрыто. Связь с ЭБУ активна.")
            }
        }

        dialog.show()

        btnMeasuring.text = "ОКНО ОТКРЫТО"
        btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DC2626"))
        setResultText("Открыто окно измерений и осциллограммы (Группы 001–004)...")

        // Пауза фонового keep-alive 0x09 ускоряет опрос и исключает конкуренцию за busMutex
        protocol.isKeepAlivePaused = true

        liveStreamJob = lifecycleScope.launch {
            var useGroupZeroOnly = false
            var g3Supported = true
            var g4Supported = true
            var g2Supported = true
            var consecutiveErrors = 0
            var cycleCount = 0
            var prevUpdateMs = 0L

            var lastRpm: Int? = null
            var lastTemp: Int? = null
            var lastLambdaV: Double? = null
            var lastLambdaCorr: Double? = null
            var lastLambdaFactor: Double? = null
            var lastThrottle: Double? = null
            var lastAirTemp: Int? = null
            var lastBatteryV: Double? = null
            var lastInjMs: Double? = null
            var lastTiming: String? = null
            var lastTimingDeg: Double? = null
            var lastLoadPct: Double? = null
            var lastIdleSwitchClosed: Boolean? = null
            var lastModeText: String? = null
            var lastStatusBits: String? = null

            try {
                while (isActive && protocol.isSessionActive && dialog.isShowing) {
                    var gotValid = false
                    var lastErr: String? = null
                    var g1Fields = emptyList<Kw1281Protocol.MeasuredField>()
                    var g2Fields = emptyList<Kw1281Protocol.MeasuredField>()
                    var g3Fields = emptyList<Kw1281Protocol.MeasuredField>()
                    var g4Fields = emptyList<Kw1281Protocol.MeasuredField>()
                    var g0Raw = emptyList<Int>()
                    var gotG4SwitchThisCycle = false

                    if (!useGroupZeroOnly) {
                        val m1 = protocol.readMeasuringGroup(1) { }
                        if (m1 != null) {
                            if (m1.isUnsupportedNak) {
                                useGroupZeroOnly = true
                            } else if (m1.errorMessage == null && (m1.fields.isNotEmpty() || m1.rpm != null)) {
                                gotValid = true
                                m1.rpm?.let { lastRpm = it }
                                m1.coolantTemp?.let { lastTemp = it }
                                when {
                                    m1.lambdaFactor != null -> {
                                        lastLambdaFactor = m1.lambdaFactor
                                        lastLambdaV = null
                                        lastLambdaCorr = null
                                    }
                                    m1.lambdaCorrection != null -> {
                                        lastLambdaCorr = m1.lambdaCorrection
                                        lastLambdaV = null
                                        lastLambdaFactor = null
                                    }
                                    m1.lambdaVoltage != null -> {
                                        lastLambdaV = m1.lambdaVoltage
                                        lastLambdaCorr = null
                                        lastLambdaFactor = null
                                    }
                                }
                                if (m1.idleSwitchClosed != null && (!g4Supported || lastIdleSwitchClosed == null)) {
                                    lastIdleSwitchClosed = m1.idleSwitchClosed
                                }
                                m1.rawStatusBits?.let { if (!g4Supported || lastStatusBits == null) lastStatusBits = it }
                                g1Fields = m1.fields
                            } else {
                                lastErr = m1.errorMessage
                            }
                        }

                        if (!useGroupZeroOnly && g3Supported && isActive && protocol.isSessionActive) {
                            delay(10)
                            val m3 = protocol.readMeasuringGroup(3) { }
                            if (m3 != null && !m3.isUnsupportedNak && m3.errorMessage == null) {
                                gotValid = true
                                m3.rpm?.let { lastRpm = it }
                                m3.coolantTemp?.let { if (lastTemp == null) lastTemp = it }
                                m3.throttleAngle?.let { lastThrottle = it }
                                m3.engineLoadPct?.let { lastLoadPct = it }
                                m3.ignitionTiming?.let { lastTiming = it }
                                m3.ignitionTimingDeg?.let { lastTimingDeg = it }
                                m3.intakeAirTemp?.let { if (lastAirTemp == null) lastAirTemp = it }
                                g3Fields = m3.fields
                            } else if (m3?.isUnsupportedNak == true) {
                                g3Supported = false
                            }
                        }

                        // Группа 004: концевик ДЗ (F60), режим работы, нагрузка, скорость или ДТОЖ
                        if (!useGroupZeroOnly && g4Supported && isActive && protocol.isSessionActive) {
                            delay(10)
                            val m4 = protocol.readMeasuringGroup(4) { }
                            if (m4 != null && !m4.isUnsupportedNak && m4.errorMessage == null) {
                                gotValid = true
                                m4.rpm?.let { if (lastRpm == null) lastRpm = it }
                                m4.coolantTemp?.let { if (lastTemp == null) lastTemp = it }
                                m4.intakeAirTemp?.let { if (lastAirTemp == null) lastAirTemp = it }
                                m4.engineLoadPct?.let { if (lastLoadPct == null) lastLoadPct = it }
                                m4.idleSwitchClosed?.let {
                                    lastIdleSwitchClosed = it
                                    gotG4SwitchThisCycle = true
                                }
                                m4.operatingModeText?.let { lastModeText = it }
                                m4.rawStatusBits?.let { lastStatusBits = it }
                                g4Fields = m4.fields
                            } else if (m4?.isUnsupportedNak == true) {
                                g4Supported = false
                            }
                        }

                        // Опрос вторичной Группы 002 (АКБ, время впрыска, ДТВВ) раз в 3 цикла для высокой частоты
                        val pollG2Now = g2Supported && (cycleCount % 3 == 0 || lastBatteryV == null || lastInjMs == null)

                        if (!useGroupZeroOnly && pollG2Now && isActive && protocol.isSessionActive) {
                            delay(10)
                            val m2 = protocol.readMeasuringGroup(2) { }
                            if (m2 != null && !m2.isUnsupportedNak && m2.errorMessage == null) {
                                gotValid = true
                                m2.batteryVoltage?.let { lastBatteryV = it }
                                m2.injectionTimeMs?.let { lastInjMs = it }
                                m2.intakeAirTemp?.let { lastAirTemp = it }
                                g2Fields = m2.fields
                            } else if (m2?.isUnsupportedNak == true) {
                                g2Supported = false
                            }
                        }
                    }

                    // Фоллбек на Группу 000 (10 байт Mono-Motronic): если Группа 001 отклонена ИЛИ ДТОЖ/Лямбда отсутствуют
                    val needGroupZeroFallback = useGroupZeroOnly || lastTemp == null || (lastLambdaV == null && lastLambdaCorr == null && lastLambdaFactor == null)
                    if (needGroupZeroFallback && isActive && protocol.isSessionActive) {
                        delay(10)
                        val m0 = protocol.readMeasuringGroup(0) { }
                        if (m0 != null && m0.errorMessage == null && (m0.rawValues.isNotEmpty() || m0.fields.isNotEmpty())) {
                            gotValid = true
                            m0.rpm?.let { if (lastRpm == null || useGroupZeroOnly) lastRpm = it }
                            m0.coolantTemp?.let { lastTemp = it }
                            val hasG1Lambda = lastLambdaV != null || lastLambdaCorr != null || lastLambdaFactor != null
                            m0.lambdaVoltage?.let { if (!hasG1Lambda || useGroupZeroOnly) lastLambdaV = it }
                            m0.lambdaCorrection?.let { if (!hasG1Lambda || useGroupZeroOnly) lastLambdaCorr = it }
                            m0.throttleAngle?.let { if (lastThrottle == null || useGroupZeroOnly) lastThrottle = it }
                            m0.batteryVoltage?.let { if (lastBatteryV == null || useGroupZeroOnly) lastBatteryV = it }
                            m0.intakeAirTemp?.let { if (lastAirTemp == null || useGroupZeroOnly) lastAirTemp = it }
                            m0.idleSwitchClosed?.let { if (!gotG4SwitchThisCycle && (lastIdleSwitchClosed == null || useGroupZeroOnly)) lastIdleSwitchClosed = it }
                            m0.operatingModeText?.let { if (lastModeText == null || useGroupZeroOnly) lastModeText = it }
                            g0Raw = m0.rawValues
                        } else if (m0 != null && !gotValid) {
                            lastErr = m0.errorMessage
                        }
                    }

                    if (gotValid) {
                        consecutiveErrors = 0
                        val nowMs = System.currentTimeMillis()
                        val hzText = if (prevUpdateMs > 0L && nowMs > prevUpdateMs) {
                            val hz = 1000.0 / (nowMs - prevUpdateMs).toDouble()
                            "%.1f Гц".format(hz)
                        } else {
                            "опрос..."
                        }
                        prevUpdateMs = nowMs

                        val sampleMap = LinkedHashMap<SensorChannel, Float>()
                        lastRpm?.let { sampleMap[SensorChannel.RPM] = it.toFloat() }
                        lastTemp?.let { sampleMap[SensorChannel.COOLANT] = it.toFloat() }
                        val lambdaNumeric = lastLambdaV ?: lastLambdaCorr ?: lastLambdaFactor
                        val lambdaUnit = when {
                            lastLambdaV != null -> "В"
                            lastLambdaCorr != null -> "%"
                            else -> "λ"
                        }
                        lambdaNumeric?.let { sampleMap[SensorChannel.LAMBDA] = it.toFloat() }
                        lastThrottle?.let { sampleMap[SensorChannel.THROTTLE] = it.toFloat() }
                        lastBatteryV?.let { sampleMap[SensorChannel.BATTERY] = it.toFloat() }
                        lastInjMs?.let { sampleMap[SensorChannel.INJECTION] = it.toFloat() }
                        lastAirTemp?.let { sampleMap[SensorChannel.AIR_TEMP] = it.toFloat() }
                        lastTimingDeg?.let { sampleMap[SensorChannel.TIMING] = it.toFloat() }
                        lastLoadPct?.let { sampleMap[SensorChannel.LOAD] = it.toFloat() }
                        lastIdleSwitchClosed?.let { sampleMap[SensorChannel.IDLE_SWITCH] = if (it) 1f else 0f }

                        val rawSummary = buildString {
                            append(if (useGroupZeroOnly) "Режим: Группа 000 (10 байт)\n" else "Сырые группы KWP1281:\n")
                            if (g1Fields.isNotEmpty()) append("Гр.001: ${g1Fields.joinToString(" | ") { it.valueText }}\n")
                            if (g2Fields.isNotEmpty()) append("Гр.002: ${g2Fields.joinToString(" | ") { it.valueText }}\n")
                            if (g3Fields.isNotEmpty()) append("Гр.003: ${g3Fields.joinToString(" | ") { it.valueText }}\n")
                            if (g4Fields.isNotEmpty()) append("Гр.004: ${g4Fields.joinToString(" | ") { it.valueText }}\n")
                            if (g0Raw.isNotEmpty()) append("Байты 000: ${g0Raw.joinToString(" ") { "%03d".format(it) }}")
                        }.trim()

                        runOnUiThread {
                            if (!dialog.isShowing) return@runOnUiThread
                            views.tvStatus.text = "${protocol.negotiatedBaud} бод • Частота: $hzText"
                            views.scopeView.setLambdaUnitLabel(lambdaUnit)
                            views.scopeView.appendSample(nowMs, sampleMap)

                            lastRpm?.let { views.tvRpm.text = "$it" }
                            lastTemp?.let { views.tvTemp.text = "$it" }
                            if (lastLambdaV != null) {
                                views.tvLambda.text = "%.2f".format(lastLambdaV)
                                views.tvLambdaUnit.text = "Вольт"
                            } else if (lastLambdaCorr != null) {
                                views.tvLambda.text = "%.1f".format(lastLambdaCorr)
                                views.tvLambdaUnit.text = "% коррекция"
                            } else if (lastLambdaFactor != null) {
                                views.tvLambda.text = "%.3f".format(lastLambdaFactor)
                                views.tvLambdaUnit.text = "λ фактор"
                            }
                            lastThrottle?.let { views.tvThrottle.text = "%.1f".format(it) }
                            lastBatteryV?.let { views.tvBattery.text = "%.2f".format(it) }
                            lastInjMs?.let { views.tvInj.text = "%.2f".format(it) }
                            lastAirTemp?.let { views.tvAirTemp.text = "$it" }
                            lastTiming?.let { views.tvTiming.text = it }
                            lastLoadPct?.let { views.tvLoad.text = "%.0f%%".format(it) }

                            if (lastIdleSwitchClosed != null || lastModeText != null || lastStatusBits != null) {
                                when (lastIdleSwitchClosed) {
                                    true -> {
                                        views.tvIdleSwitch.text = "ЗАМКНУТ (ХХ)"
                                        views.tvIdleSwitch.setTextColor(Color.parseColor("#10B981"))
                                    }
                                    false -> {
                                        views.tvIdleSwitch.text = "РАЗОМКНУТ (Газ)"
                                        views.tvIdleSwitch.setTextColor(Color.parseColor("#F59E0B"))
                                    }
                                    null -> {
                                        views.tvIdleSwitch.text = "---"
                                        views.tvIdleSwitch.setTextColor(Color.parseColor("#94A3B8"))
                                    }
                                }
                                views.tvMode.text = "Режим: ${lastModeText ?: lastStatusBits ?: "---"}"
                            }

                            if (rawSummary.isNotEmpty()) {
                                views.tvRawGroups.text = rawSummary
                            }
                        }
                    } else {
                        consecutiveErrors++
                        if (consecutiveErrors >= 3) {
                            runOnUiThread {
                                if (dialog.isShowing) {
                                    views.tvStatus.text = "Нет ответа от ЭБУ..."
                                    views.tvRawGroups.text = "⚠️ Нет данных от ЭБУ при чтении измерений.\nПричина: ${lastErr ?: "ЭБУ не отвечает"}.\nПроверьте зажигание и соединение K-Line."
                                }
                            }
                        }
                    }

                    cycleCount++
                    delay(10)
                }
            } catch (t: Throwable) {
                // Корректное завершение при отмене job
            } finally {
                liveStreamJob = null
                if (basicSettingsJob == null) {
                    protocol.isKeepAlivePaused = false
                }
                runOnUiThread {
                    btnMeasuring.text = if (selectedEcuAddress == 0x25) "СТАТУС ИММО (08)" else "ИЗМЕРЕНИЯ (08)"
                    btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#8B5CF6"))
                }
            }
        }
    }

    private fun updateScopeHeaderAndCards(views: MeasuringWindowViews) {
        val density = resources.displayMetrics.density
        views.layoutScopePanel.visibility = if (isScopePanelVisible) View.VISIBLE else View.GONE
        views.btnToggleScope.text = if (isScopePanelVisible) "СКРЫТЬ" else "ГРАФИКИ"
        views.btnToggleScope.backgroundTintList = ColorStateList.valueOf(
            Color.parseColor(if (isScopePanelVisible) "#0284C7" else "#334155")
        )
        views.tvScopeCount.text = "ОСЦИЛЛОГРАММА (${selectedScopeChannels.size} кан.)"

        for ((channel, pair) in views.channelCards) {
            val (card, badge) = pair
            val active = selectedScopeChannels.contains(channel)
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor(if (active) "#0F172A" else "#1E293B"))
                cornerRadius = 8f * density
                setStroke(
                    if (active) (2f * density).toInt() else (1f * density).toInt(),
                    if (active) channel.colorInt else Color.parseColor("#334155")
                )
            }
            card.background = bg
            if (active) {
                badge.text = "● НА ГРАФИКЕ"
                badge.setTextColor(channel.colorInt)
            } else {
                badge.text = "+ график"
                badge.setTextColor(Color.parseColor("#64748B"))
            }
        }
    }

    private fun cancelLiveStreamJobOnly() {
        liveStreamJob?.cancel()
        liveStreamJob = null
        if (basicSettingsJob == null) {
            kwProtocol?.isKeepAlivePaused = false
        }
        runOnUiThread {
            btnMeasuring.text = if (selectedEcuAddress == 0x25) "СТАТУС ИММО (08)" else "ИЗМЕРЕНИЯ (08)"
            btnMeasuring.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#8B5CF6"))
        }
    }

    private fun stopLiveStream() {
        cancelLiveStreamJobOnly()
        try {
            measuringDialog?.dismiss()
        } catch (_: Throwable) {}
        measuringDialog = null
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
                    setResultText("АКТИВЕН ТЕСТ ИСПОЛНИТЕЛЕЙ (0x04):\n\n${res.text}\n\n" +
                            "Для перехода к следующему механизму нажмите «СЛЕДУЮЩИЙ ТЕСТ».")
                } else {
                    layoutActuatorTest.visibility = View.GONE
                    setResultText(res.text)
                }
            } catch (t: Throwable) {
                btnActuatorNext.isEnabled = true
                layoutActuatorTest.visibility = View.GONE
                setResultText("Ошибка шага теста исполнителей: ${t.message}")
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
        val wasLiveRunning = liveStreamJob != null
        stopLiveStream()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = View.GONE

        btnBasicSettings.text = "СТОП БАЗОВЫЕ"
        btnBasicSettings.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DC2626"))
        setResultText("Вход в режим базовых установок (0x28 / 0x11)...")

        basicSettingsJob = lifecycleScope.launch {
            var activeGroup = 0
            try {
                if (wasLiveRunning) delay(80)
                var initialResult = protocol.enterBasicSettings(0) { }
                var fallbackMsg: String? = null
                if (!initialResult.success && protocol.isSessionActive) {
                    delay(80)
                    val fallbackGroup1 = protocol.enterBasicSettings(1) { }
                    if (fallbackGroup1.success) {
                        activeGroup = 1
                        initialResult = fallbackGroup1
                    } else {
                        fallbackMsg = fallbackGroup1.message
                    }
                }

                if (!initialResult.success) {
                    val details = buildString {
                        append("❌ Не удалось войти в Базовые установки:\n")
                        append("• Группа 000: ${initialResult.message}\n")
                        if (!fallbackMsg.isNullOrEmpty()) {
                            append("• Группа 001: $fallbackMsg\n")
                        }
                        append("\nУсловия входа для Bosch Mono-Motronic 1.2.3 (1.8 ADZ):\n")
                        append("1. Для Группы 000 (УОЗ 6°): двигатель ЗАВЕДЁН на холостых, прогрет >80°C, педаль газа отпущена.\n")
                        append("2. Для Группы 001 (адаптация РХХ/ДПДЗ): зажигание ВКЛ, двигатель ЗАГЛУШЕН, педаль газа не нажата.\n")
                        append("3. В памяти ЭБУ не должно быть активных ошибок — сначала нажмите «ОШИБКИ (07)» и «СТЕРЕТЬ (05)».")
                    }
                    setResultText(details)
                    return@launch
                }

                var pendingFirstResult: Kw1281Protocol.BasicSettingsResult? = initialResult

                while (isActive && protocol.isSessionActive) {
                    val res = pendingFirstResult ?: protocol.enterBasicSettings(activeGroup) { }
                    pendingFirstResult = null

                    if (!res.success) {
                        setResultText("Базовые установки прерваны: ${res.message}")
                        break
                    }

                    val m = res.measurement
                    val sensorSummary = if (m != null) {
                        buildString {
                            m.rpm?.let { append("• Обороты: $it об/мин\n") }
                            m.coolantTemp?.let { append("• ДТОЖ: $it °C\n") }
                            m.throttleAngle?.let { append("• ДПДЗ: %.1f °\n".format(it)) }
                            m.ignitionTiming?.let { append("• УОЗ: $it\n") }
                            when {
                                m.lambdaVoltage != null -> append("• Лямбда: %.2f В\n".format(m.lambdaVoltage))
                                m.lambdaCorrection != null -> append("• Лямбда: %.1f %%\n".format(m.lambdaCorrection))
                                m.lambdaFactor != null -> append("• Лямбда: %.3f λ\n".format(m.lambdaFactor))
                            }
                            m.idleSwitchClosed?.let {
                                append("• Концевик ДЗ (F60): ${if (it) "ЗАМКНУТ (ХХ)" else "РАЗОМКНУТ"}\n")
                            }
                        }
                    } else ""

                    val extraLine = when {
                        m != null && m.rawValues.isNotEmpty() && m.rawValues.size == 10 ->
                            "Байты 000: ${m.rawValues.joinToString(" ") { "%03d".format(it) }}"
                        m != null && m.fields.isNotEmpty() ->
                            "Параметры: ${m.fields.joinToString(" | ") { it.valueText }}"
                        else -> res.message
                    }

                    setResultText("🔧 РЕЖИМ БАЗОВЫХ УСТАНОВОК (Группа %03d) АКТИВЕН!\n\n".format(activeGroup) +
                            "• ЭБУ зафиксировал базовый угол опережения зажигания (keep-alive 0x09 приостановлен).\n" +
                            "• Для регулировки УОЗ 6° до ВМТ проверьте прогрев (>80°C) и работайте стробоскопом по метке маховика.\n" +
                            (if (sensorSummary.isNotEmpty()) "\n$sensorSummary" else "") +
                            "• $extraLine\n\n" +
                            "Нажмите «СТОП БАЗОВЫЕ» для выхода из режима.")

                    delay(250)
                }
            } catch (t: Throwable) {
                // Остановка по отмене
            } finally {
                basicSettingsJob = null
                protocol.isKeepAlivePaused = false
                lifecycleScope.launch {
                    try {
                        protocol.finishBasicSettings()
                    } catch (_: Throwable) {}
                }
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
        kwProtocol?.isKeepAlivePaused = false
        runOnUiThread {
            btnBasicSettings.text = "БАЗОВЫЕ (УОЗ 6°)"
            btnBasicSettings.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#0D9488"))
        }
    }

    // Блок Адаптации (только Канал 00: 0x21 / 0x2A)
    private fun toggleAdaptationPanel() {
        stopAllBackgroundLoops()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = if (layoutAdaptation.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    private fun parseAdaptValue(): Int? {
        val v = etAdaptValue.text.toString().trim().toIntOrNull()
        if (v == null || v !in 0..65535) {
            setResultText("Ошибка ввода: значение адаптации должно быть от 0 до 65535.")
            return null
        }
        return v
    }

    private fun setAdaptationButtonsEnabled(enabled: Boolean) {
        btnAdaptRead.isEnabled = enabled
        btnAdaptSave.isEnabled = enabled
    }

    private fun performAdaptationRead() {
        val protocol = kwProtocol ?: return
        val channel = 0

        lifecycleScope.launch {
            stopAllBackgroundLoops()
            setAdaptationButtonsEnabled(false)
            val res = protocol.readAdaptation(channel)
            setAdaptationButtonsEnabled(true)

            if (res.success) {
                etAdaptValue.setText(res.value.toString())
                setResultText("✅ ${res.message}\n\n" +
                        "Текущее сохранённое значение канала 00 загружено в поле «Значение».")
            } else {
                setResultText("⚠️ ${res.message}\n\n" +
                        "ℹ️ Подсказка: На многих блоках Mono-Motronic и Иммо канал 00 не поддерживает чтение — для сброса адаптаций / привязки ЭБУ введите значение 0 и сразу нажмите «СОХРАНИТЬ».")
            }
        }
    }

    private fun performAdaptationSave() {
        val protocol = kwProtocol ?: return
        val channel = 0
        val value = parseAdaptValue() ?: return

        lifecycleScope.launch {
            stopAllBackgroundLoops()
            setAdaptationButtonsEnabled(false)
            val res = protocol.saveAdaptation(channel, value)
            setAdaptationButtonsEnabled(true)

            if (res.success) {
                val extra = if (selectedEcuAddress == 0x25) {
                    "\n\n🔑 ВАЖНО ДЛЯ ИММОБИЛАЙЗЕРА:\nВыключите зажигание минимум на 30 секунд для завершения привязки ЭБУ к иммобилайзеру."
                } else {
                    "\n\n🔄 Сброс выученных адаптаций Mono-Motronic выполнен! После выключения зажигания на 15 сек блок заново обучит холостой ход."
                }
                setResultText("✅ ${res.message}$extra")
            } else {
                setResultText("⚠️ ${res.message}")
            }
        }
    }

    private fun showEcuPassport() {
        val protocol = kwProtocol ?: return
        val isImmo = selectedEcuAddress == 0x25
        val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else (if (isImmo) "1H0 953 257" else "3A0 907 311")
        val comp = if (protocol.ecuComponent.isNotEmpty()) protocol.ecuComponent else (if (isImmo) "IMMOBILIZER VDO V01" else "1.8l R4 MONO 1.2.3 D30")
        val extra = if (protocol.ecuExtra.isNotEmpty()) protocol.ecuExtra else "WSC 01317 / Код 00000"

        setResultText("ПАСПОРТНЫЕ ДАННЫЕ БЛОКА УПРАВЛЕНИЯ:\n" +
                "• Блок: ${if (isImmo) "Иммобилайзер (0x25)" else "ЭБУ Двигателя (0x01)"}\n" +
                "• Номер VAG: $pNum\n" +
                "• Компонент: $comp\n" +
                "• Кодировка / Дилер: $extra\n" +
                "• Протокол связи: KWP1281 (скорость ${protocol.negotiatedBaud} бод, 8N1)\n" +
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
