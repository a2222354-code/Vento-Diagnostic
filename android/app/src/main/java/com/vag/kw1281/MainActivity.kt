package com.vag.kw1281

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
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

    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceInfo: TextView
    private lateinit var tvBaudBadge: TextView
    private lateinit var tvLogs: TextView
    private lateinit var scrollViewLogs: ScrollView

    private lateinit var tvGaugeRpm: TextView
    private lateinit var tvGaugeTemp: TextView
    private lateinit var tvGaugeLambda: TextView
    private lateinit var tvGaugeThrottle: TextView

    private lateinit var btnFindUsb: Button
    private lateinit var btnConnectEcu: Button
    private lateinit var btnReadFaults: Button
    private lateinit var btnClearFaults: Button
    private lateinit var btnMeasuring: Button
    private lateinit var btnBasicSettings: Button
    private lateinit var btnEcuPassport: Button
    private lateinit var btnShareReport: Button
    private lateinit var btnClearLog: Button

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
                        addLog("Разрешение на работу с USB получено!")
                        btnConnectEcu.isEnabled = true
                    } else {
                        addLog("Предупреждение: Разрешение на USB было отклонено пользователем.")
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
                        stopLiveStream()
                        disconnectSession()
                        foundDevice = null
                        setDiagnosticButtonsEnabled(false)
                        btnConnectEcu.isEnabled = false
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
                addLog("Непредвиденная ошибка: ${throwable.message ?: throwable.javaClass.simpleName}")
                defaultHandler?.uncaughtException(thread, throwable)
            }

            setContentView(R.layout.activity_main)

            usbManager = getSystemService(Context.USB_SERVICE) as? UsbManager

            tvStatus = findViewById(R.id.tvStatus)
            tvDeviceInfo = findViewById(R.id.tvDeviceInfo)
            tvBaudBadge = findViewById(R.id.tvBaudBadge)
            tvLogs = findViewById(R.id.tvLogs)
            scrollViewLogs = findViewById(R.id.scrollViewLogs)

            tvGaugeRpm = findViewById(R.id.tvGaugeRpm)
            tvGaugeTemp = findViewById(R.id.tvGaugeTemp)
            tvGaugeLambda = findViewById(R.id.tvGaugeLambda)
            tvGaugeThrottle = findViewById(R.id.tvGaugeThrottle)

            btnFindUsb = findViewById(R.id.btnFindUsb)
            btnConnectEcu = findViewById(R.id.btnConnectEcu)
            btnReadFaults = findViewById(R.id.btnReadFaults)
            btnClearFaults = findViewById(R.id.btnClearFaults)
            btnMeasuring = findViewById(R.id.btnMeasuring)
            btnBasicSettings = findViewById(R.id.btnBasicSettings)
            btnEcuPassport = findViewById(R.id.btnEcuPassport)
            btnShareReport = findViewById(R.id.btnShareReport)
            btnClearLog = findViewById(R.id.btnClearLog)

            btnFindUsb.setOnClickListener { findUsbAdapter() }
            btnConnectEcu.setOnClickListener { connectToEcu() }
            btnReadFaults.setOnClickListener { readFaultCodes() }
            btnClearFaults.setOnClickListener { clearFaultCodes() }
            btnMeasuring.setOnClickListener { toggleLiveMeasuring() }
            btnBasicSettings.setOnClickListener { enterBasicSettings() }
            btnEcuPassport.setOnClickListener { showEcuPassport() }
            btnShareReport.setOnClickListener { copyDiagnosticReport() }
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

            addLog("=== VENTO DIAGNOSTIC ===")
            addLog("VW Vento 1995 1.8 ADZ (Bosch Mono-Motronic 1.2.3, 3A0 907 311)")
            addLog("Протокол VAG KWP1281: 5-бодовая инициализация 7O1 -> 9600 бод 8N1")
            findUsbAdapter()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun addLog(msg: String) {
        runOnUiThread {
            try {
                val current = tvLogs.text.toString()
                val newText = if (current.isEmpty()) msg else "$current\n$msg"
                tvLogs.text = newText
                scrollViewLogs.post {
                    scrollViewLogs.fullScroll(ScrollView.FOCUS_DOWN)
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
        btnBasicSettings.isEnabled = enabled
        btnEcuPassport.isEnabled = enabled
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
            setDiagnosticButtonsEnabled(false)
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
            addLog("Ошибка запроса прав USB: ${e.message}")
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
                stopLiveStream()
                btnConnectEcu.isEnabled = false
                setDiagnosticButtonsEnabled(false)
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
                    tvStatus.text = "ЭБУ подключен: $pNum"
                    tvBaudBadge.text = "${protocol.negotiatedBaud} 8N1"
                    btnConnectEcu.isEnabled = true
                    setDiagnosticButtonsEnabled(true)
                    addLog("--- Доступные функции: Ошибки (0x07), Стереть (0x05), Измерения (0x08), Базовые (0x28) ---")
                } else {
                    tvStatus.text = "Ошибка связи с ЭБУ"
                    btnConnectEcu.isEnabled = true
                }
            } catch (t: Throwable) {
                t.printStackTrace()
                addLog("Сбой при подключении: ${t.message ?: t.javaClass.simpleName}")
                tvStatus.text = "Ошибка подключения"
                btnConnectEcu.isEnabled = true
            }
        }
    }

    private fun readFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
                btnReadFaults.isEnabled = false
                val faults = protocol.readFaultCodesDetailed { msg -> addLog(msg) }
                btnReadFaults.isEnabled = true

                if (faults.isEmpty()) {
                    addLog("==========================================")
                    addLog("В памяти ЭБУ ошибок нет (DTC 00000).")
                    addLog("Все датчики и исполнители в пределах допуска.")
                    addLog("==========================================")
                } else {
                    addLog("==========================================")
                    addLog("НАЙДЕНО НЕИСПРАВНОСТЕЙ: ${faults.size}")
                    addLog("==========================================")
                    for (f in faults) {
                        addLog("• Код: ${f.code} — ${f.component}")
                        addLog("  Статус: ${f.statusText}")
                        addLog("  Причина: ${f.cause}")
                        addLog("  Совет: ${f.remedy}")
                        if (f.isNormalWhenStopped) {
                            addLog("  ℹ️ ПРИМЕЧАНИЕ: На Mono-Motronic 1.2.3 эта ошибка является штатной при незаведённом двигателе!")
                        }
                        addLog("------------------------------------------")
                    }
                }
            } catch (t: Throwable) {
                btnReadFaults.isEnabled = true
                addLog("Ошибка чтения DTC: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    private fun clearFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
                btnClearFaults.isEnabled = false
                val success = protocol.clearFaultCodes { msg -> addLog(msg) }
                btnClearFaults.isEnabled = true
                if (success) {
                    addLog("Память ошибок ЭБУ очищена! Повторите чтение для подтверждения.")
                }
            } catch (t: Throwable) {
                btnClearFaults.isEnabled = true
                addLog("Ошибка стирания DTC: ${t.message ?: t.javaClass.simpleName}")
            }
        }
    }

    private fun toggleLiveMeasuring() {
        if (liveStreamJob != null) {
            stopLiveStream()
            btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
            addLog("Поток измерений остановлен.")
            return
        }

        val protocol = kwProtocol ?: run {
            addLog("Сначала подключитесь к ЭБУ.")
            return
        }

        btnMeasuring.text = "СТОП (08)"
        addLog("Запуск потока Live Data (Группа 000)...")

        liveStreamJob = lifecycleScope.launch {
            try {
                while (isActive) {
                    val m = protocol.readMeasuringGroup(0) { msg -> /* тихий режим */ }
                    if (m != null) {
                        updateGauges(m)
                    }
                    delay(450)
                }
            } catch (t: Throwable) {
                addLog("Сбой потока измерений: ${t.message}")
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

    private fun enterBasicSettings() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
                btnBasicSettings.isEnabled = false
                addLog("==========================================")
                addLog("ВХОД В РЕЖИМ БАЗОВЫХ УСТАНОВОК (0x28, Группа 000)")
                addLog("Внимание: ЭБУ отключает динамическое опережение зажигания!")
                addLog("Обороты фиксируются на ~850–900 об/мин.")
                addLog("Теперь можно выставлять угол зажигания 6° до ВМТ стробоскопом.")
                addLog("==========================================")

                val result = protocol.enterBasicSettings(0) { msg -> addLog(msg) }
                btnBasicSettings.isEnabled = true
                if (result != null) {
                    updateGauges(result)
                    addLog("Базовые установки активны. Сырые значения группы 000:")
                    addLog(result.rawValues.joinToString(" ") { "%03d".format(it) })
                }
            } catch (t: Throwable) {
                btnBasicSettings.isEnabled = true
                addLog("Ошибка базовых установок: ${t.message}")
            }
        }
    }

    private fun showEcuPassport() {
        val protocol = kwProtocol ?: return
        addLog("==========================================")
        addLog("ПАСПОРТНЫЕ ДАННЫЕ ЭБУ (Mono-Motronic):")
        addLog("• Номер VAG: ${if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else "3A0 907 311"}")
        addLog("• Компонент: ${if (protocol.ecuComponent.isNotEmpty()) protocol.ecuComponent else "1.8l R4 MONO 1.2.3 D30"}")
        addLog("• Кодировка / Доп: ${if (protocol.ecuExtra.isNotEmpty()) protocol.ecuExtra else "WSC 01317 / Код 00000"}")
        addLog("• Скорость сеанса: ${protocol.negotiatedBaud} бод (8N1)")
        addLog("• Двигатель: 1.8 ADZ (66 кВт / 90 л.с., 1995)")
        addLog("==========================================")
    }

    private fun copyDiagnosticReport() {
        try {
            val logText = tvLogs.text.toString()
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = ClipData.newPlainText("Vento Diagnostic Log", logText)
            clipboard.setPrimaryClip(clip)
            Toast.makeText(this, "Диагностический отчёт скопирован в буфер обмена!", Toast.LENGTH_SHORT).show()
            addLog("Отчёт скопирован в буфер обмена.")
        } catch (e: Exception) {
            addLog("Ошибка копирования отчёта: ${e.message}")
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
