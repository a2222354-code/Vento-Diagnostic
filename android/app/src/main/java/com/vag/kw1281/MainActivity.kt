package com.vag.kw1281

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
                    addLog("USB устройство отключено.")
                    disconnectSession()
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
                addLog("Непредвиденная ошибка: ${throwable.message ?: throwable.javaClass.simpleName}")
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
                btnConnectEcu.isEnabled = false
                btnReadFaults.isEnabled = false
                btnClearFaults.isEnabled = false
                tvStatus.text = "Статус: Инициализация K-Line 5 бод..."
                
                disconnectSession()

                val driver = Ftdi5BaudDriver(manager, dev)
                if (driver.open(9600)) {
                    kwDriver = driver
                    val protocol = Kw1281Protocol(driver)
                    kwProtocol = protocol
                    val success = protocol.connect { msg -> addLog(msg) }
                    if (success) {
                        val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else "3A0 907 311"
                        tvStatus.text = "ЭБУ подключен: $pNum (9600 бод)"
                        btnConnectEcu.isEnabled = true
                        btnReadFaults.isEnabled = true
                        btnClearFaults.isEnabled = true
                    } else {
                        tvStatus.text = "Ошибка связи с ЭБУ"
                        btnConnectEcu.isEnabled = true
                    }
                } else {
                    tvStatus.text = "Не удалось открыть USB порт"
                    val err = driver.lastError ?: "Неизвестная ошибка"
                    addLog("Ошибка открытия порта: $err")
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
                btnReadFaults.isEnabled = false
                val faults = protocol.readFaultCodes { msg -> addLog(msg) }
                btnReadFaults.isEnabled = true
                if (faults.isEmpty()) {
                    addLog("В памяти ЭБУ ошибок нет (DTC 00000). Все системы в норме!")
                } else {
                    addLog("Всего обнаружено неисправностей: ${faults.size}")
                    for ((dtc, desc) in faults) {
                        addLog("• $dtc — $desc")
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
                btnClearFaults.isEnabled = false
                val success = protocol.clearFaultCodes { msg -> addLog(msg) }
                btnClearFaults.isEnabled = true
                if (success) {
                    addLog("Память ошибок очищена! Повторите чтение для проверки.")
                }
            } catch (t: Throwable) {
                btnClearFaults.isEnabled = true
                addLog("Ошибка стирания DTC: ${t.message ?: t.javaClass.simpleName}")
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
