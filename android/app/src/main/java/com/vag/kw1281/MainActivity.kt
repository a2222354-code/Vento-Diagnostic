package com.vag.kw1281

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
                resetGauges()

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

    private suspend fun checkImmobilizerStatus(protocol: Kw1281Protocol) {
        val status = protocol.readImmobilizerStatus { }
        if (status != null) {
            tvImmoKeyStatus.text = "• Транспондер ключа: ${if (status.keyAuthorized) "✅ Распознан (ID33 OK)" else "❌ ОШИБКА (Чип не прочитан)"}"
            tvImmoStartStatus.text = "• Разрешение пуска двигателя: ${if (status.startPermitted) "✅ РАЗРЕШЁН" else "❌ ЗАБЛОКИРОВАН (заглохнет через 1 сек)"}"
            tvImmoKeyCount.text = "• Ключей обучено в памяти: ${status.keyCount} шт."

            setResultText("Блок иммобилайзера 1H0 953 257 подключен!\n\n" +
                    "ДИАГНОСТИКА КЛЮЧА И СИСТЕМЫ ПУСКА:\n" +
                    "• Разрешение запуска: ${if (status.startPermitted) "РАЗРЕШЕНО (ЭБУ не блокируется)" else "ЗАПРЕЩЕНО (Блокировка мотора)"}\n" +
                    "• Ответ ЭБУ двигателя: ${if (status.ecuResponds) "Есть связь по W-Line" else "Нет связи с моторным ЭБУ"}\n" +
                    "• Транспондер чипа: ${if (status.keyAuthorized) "Авторизован" else "Не авторизован / Слабый сигнал катушки"}\n" +
                    "• Ключей прописано: ${status.keyCount}\n\n" +
                    "Для синхронизации ЭБУ с иммобилайзером откройте «АДАПТАЦИЯ (10)» → Канал 00 → «СОХРАНИТЬ» (значение 0).")
        } else {
            setResultText("Иммобилайзер подключен. Номер блока: ${protocol.ecuPartNumber}\n" +
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
                        sb.append(if (useGroupZeroOnly) "ЖИВЫЕ ПАРАМЕТРЫ (ГРУППА 000):\n" else "ЖИВЫЕ ПАРАМЕТРЫ ДАТЧИКОВ (ГРУППЫ 001 / 003):\n")
                        sb.append("• Обороты (G40): ").append(lastRpm?.let { "$it об/мин" } ?: "---").append("\n")
                        sb.append("• ДТОЖ (G62): ").append(lastTemp?.let { "$it °C" } ?: "---").append("\n")
                        val lambdaText = when {
                            lastLambdaV != null -> "%.2f В".format(lastLambdaV)
                            lastLambdaCorr != null -> "%.1f %% (коррекция)".format(lastLambdaCorr)
                            else -> "---"
                        }
                        sb.append("• Лямбда-зонд (G39): ").append(lambdaText).append("\n")
                        sb.append("• ДПДЗ угол (G69): ").append(lastThrottle?.let { "%.1f °".format(it) } ?: "---").append("\n")
                        lastBatteryV?.let { sb.append("• Напряжение АКБ: %.2f В\n".format(it)) }
                        lastInjMs?.let { sb.append("• Время впрыска: %.2f мс\n".format(it)) }
                        lastAirTemp?.let { sb.append("• ДТВВ (G42): $it °C\n") }

                        if (g1Fields.isNotEmpty()) {
                            sb.append("\nГруппа 001: ").append(g1Fields.joinToString(" | ") { it.valueText })
                        }
                        if (g3Fields.isNotEmpty()) {
                            sb.append("\nГруппа 003: ").append(g3Fields.joinToString(" | ") { it.valueText })
                        }
                        if (g0Raw.isNotEmpty()) {
                            sb.append("\nБайты 000: ").append(g0Raw.joinToString(" ") { "%03d".format(it) })
                        }
                        setResultText(sb.toString())
                    } else {
                        consecutiveErrors++
                        if (consecutiveErrors >= 3) {
                            setResultText("⚠️ Нет данных от ЭБУ при чтении измерений.\nПричина: ${lastErr ?: "ЭБУ не отвечает"}.\nПроверьте зажигание и соединение K-Line.")
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
        stopLiveStream()
        layoutActuatorTest.visibility = View.GONE
        layoutAdaptation.visibility = View.GONE

        btnBasicSettings.text = "СТОП БАЗОВЫЕ"
        btnBasicSettings.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#DC2626"))
        setResultText("Вход в режим базовых установок (0x28 / 0x11)...")

        basicSettingsJob = lifecycleScope.launch {
            var activeGroup = 0
            try {
                var initialResult = protocol.enterBasicSettings(0) { }
                if (!initialResult.success && initialResult.message.contains("NAK")) {
                    val fallbackGroup1 = protocol.enterBasicSettings(1) { }
                    if (fallbackGroup1.success) {
                        activeGroup = 1
                        initialResult = fallbackGroup1
                    }
                }

                if (!initialResult.success) {
                    setResultText("❌ Не удалось войти в Базовые установки:\n${initialResult.message}")
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
                    if (m != null) {
                        updateGaugeViews(m.rpm, m.coolantTemp, m.lambdaVoltage, m.lambdaCorrection, m.throttleAngle)
                    }

                    val extraLine = when {
                        m != null && m.rawValues.isNotEmpty() && m.rawValues.size == 10 ->
                            "Байты 000: ${m.rawValues.joinToString(" ") { "%03d".format(it) }}"
                        m != null && m.fields.isNotEmpty() ->
                            "Параметры: ${m.fields.joinToString(" | ") { it.valueText }}"
                        else -> res.message
                    }

                    setResultText("🔧 РЕЖИМ БАЗОВЫХ УСТАНОВОК (Группа %03d) АКТИВЕН!\n\n".format(activeGroup) +
                            "• ЭБУ зафиксировал базовый угол опережения зажигания.\n" +
                            "• Для регулировки УОЗ 6° до ВМТ проверьте прогрев (>80°C) и работайте стробоскопом по метке маховика.\n" +
                            "• $extraLine\n\n" +
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
                setResultText("✅ ${res.message}\n\n" +
                        "Текущее сохранённое значение канала %02d загружено в поле «Значение».".format(res.channel))
            } else {
                val tip = if (channel == 0) {
                    "\n\nℹ️ Подсказка: На многих блоках Mono-Motronic и Иммо канал 00 не поддерживает чтение — для сброса адаптаций / привязки ЭБУ введите значение 0 и сразу нажмите «СОХРАНИТЬ»."
                } else ""
                setResultText("⚠️ ${res.message}$tip")
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
                setResultText("🔍 ${res.message}\n\nЗначение $value принято блоком для проверки. Нажмите «СОХРАНИТЬ» для записи в EEPROM.")
            } else {
                setResultText("⚠️ ${res.message}")
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
                    "\n\n🔑 ВАЖНО ДЛЯ ИММОБИЛАЙЗЕРА:\nВыключите зажигание минимум на 30 секунд для завершения привязки ЭБУ к иммобилайзеру."
                } else if (selectedEcuAddress == 0x01 && channel == 0) {
                    "\n\n🔄 Сброс выученных адаптаций Mono-Motronic выполнен! После выключения зажигания на 15 сек блок заново обучит холостой ход."
                } else ""
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
