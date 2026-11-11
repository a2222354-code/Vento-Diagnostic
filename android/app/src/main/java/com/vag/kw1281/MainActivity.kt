package com.vag.kw1281

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
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

    private var selectedBaud: Int = 0 // 0 = Автоматически (9600 затем 10400)
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
            val activeColor = Color.parseColor("#38BDF8")
            val activeText = Color.parseColor("#090D16")
            val inactiveColor = Color.parseColor("#334155")
            val inactiveText = Color.parseColor("#CBD5E1")

            btnBaudAuto.setBackgroundColor(if (selectedBaud == 0) activeColor else inactiveColor)
            btnBaudAuto.setTextColor(if (selectedBaud == 0) activeText else inactiveText)

            btnBaud9600.setBackgroundColor(if (selectedBaud == 9600) activeColor else inactiveColor)
            btnBaud9600.setTextColor(if (selectedBaud == 9600) activeText else inactiveText)

            btnBaud10400.setBackgroundColor(if (selectedBaud == 10400) activeColor else inactiveColor)
            btnBaud10400.setTextColor(if (selectedBaud == 10400) activeText else inactiveText)

            btnBaud4800.setBackgroundColor(if (selectedBaud == 4800) activeColor else inactiveColor)
            btnBaud4800.setTextColor(if (selectedBaud == 4800) activeText else inactiveText)
        }

        btnBaudAuto.setOnClickListener {
            selectedBaud = 0
            updateStyles()
            addLog("Выбран режим: Авто (поиск 9600 / 10400 бод)")
        }
        btnBaud9600.setOnClickListener {
            selectedBaud = 9600
            updateStyles()
            addLog("Выбрана фиксированная скорость: 9600 бод")
        }
        btnBaud10400.setOnClickListener {
            selectedBaud = 10400
            updateStyles()
            addLog("Выбрана фиксированная скорость: 10400 бод")
        }
        btnBaud4800.setOnClickListener {
            selectedBaud = 4800
            updateStyles()
            addLog("Выбрана фиксированная скорость: 4800 бод")
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
            addLog("Ошибка запроса прав USB: ${e.message}")
        }
    }

    private fun connectToEcu() {
        val dev = foundDevice ?: return
        val manager = usbManager ?: return
        lifecycleScope.launch {
            btnConnectEcu.isEnabled = false
            tvStatus.text = "Статус: Открытие порта..."
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
                    tvStatus.text = "ЭБУ подключен: $pNum (${protocol.negotiatedBaud} бод)"
                    btnReadFaults.isEnabled = true
                    btnClearFaults.isEnabled = true
                } else {
                    tvStatus.text = "Ошибка связи с ЭБУ"
                    btnConnectEcu.isEnabled = true
                }
            } else {
                tvStatus.text = "Не удалось открыть USB порт"
                btnConnectEcu.isEnabled = true
            }
        }
    }

    private fun readFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            btnReadFaults.isEnabled = false
            val faults = protocol.readFaultCodes { msg -> addLog(msg) }
            btnReadFaults.isEnabled = true
            if (faults.isEmpty()) {
                addLog("В памяти ЭБУ ошибок нет (DTC 00000). Все системы в норме!")
            } else {
                addLog("Всего ошибок: ${faults.size}")
                for ((dtc, desc) in faults) {
                    addLog("• $dtc — $desc")
                }
            }
        }
    }

    private fun clearFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            btnClearFaults.isEnabled = false
            val success = protocol.clearFaultCodes { msg -> addLog(msg) }
            btnClearFaults.isEnabled = true
            if (success) {
                addLog("Память ошибок очищена! Повторите чтение для проверки.")
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
