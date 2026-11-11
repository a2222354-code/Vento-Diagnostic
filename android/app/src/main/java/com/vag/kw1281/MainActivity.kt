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
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var usbManager: UsbManager
    private val ACTION_USB_PERMISSION = "com.vag.kw1281.USB_PERMISSION"

    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceInfo: TextView
    private lateinit var tvLogs: TextView
    private lateinit var scrollViewLogs: ScrollView
    private lateinit var btnFindUsb: Button
    private lateinit var btnConnectEcu: Button
    private lateinit var btnReadFaults: Button
    private lateinit var btnClearFaults: Button

    private var foundDevice: UsbDevice? = null
    private var kwDriver: Ftdi5BaudDriver? = null
    private var kwProtocol: Kw1281Protocol? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        usbManager = getSystemService(Context.USB_SERVICE) as UsbManager

        tvStatus = findViewById(R.id.tvStatus)
        tvDeviceInfo = findViewById(R.id.tvDeviceInfo)
        tvLogs = findViewById(R.id.tvLogs)
        scrollViewLogs = findViewById(R.id.scrollViewLogs)
        btnFindUsb = findViewById(R.id.btnFindUsb)
        btnConnectEcu = findViewById(R.id.btnConnectEcu)
        btnReadFaults = findViewById(R.id.btnReadFaults)
        btnClearFaults = findViewById(R.id.btnClearFaults)

        btnFindUsb.setOnClickListener { findUsbAdapter() }
        btnConnectEcu.setOnClickListener { connectToEcu() }
        btnReadFaults.setOnClickListener { readFaultCodes() }
        btnClearFaults.setOnClickListener { clearFaultCodes() }

        addLog("Диагностический комплекс VW Vento 1.8 ADZ (Mono-Motronic 1.2.3)")
        findUsbAdapter()
    }

    private fun addLog(msg: String) {
        lifecycleScope.launch(Dispatchers.Main) {
            val current = tvLogs.text.toString()
            val newText = if (current.isEmpty()) msg else "$current\n$msg"
            tvLogs.text = newText
            scrollViewLogs.post {
                scrollViewLogs.fullScroll(ScrollView.FOCUS_DOWN)
            }
        }
    }

    private fun findUsbAdapter() {
        val deviceList = usbManager.deviceList
        val ftdi = deviceList.values.firstOrNull { it.vendorId == 0x0403 }
            ?: deviceList.values.firstOrNull { it.vendorId == 0x1A86 || it.vendorId == 0x10C4 }

        if (ftdi != null) {
            foundDevice = ftdi
            tvStatus.text = "Статус: Адаптер обнаружен!"
            tvDeviceInfo.text = "Устройство: VID 0x%04X, PID 0x%04X".format(ftdi.vendorId, ftdi.productId)
            btnConnectEcu.isEnabled = true
            requestUsbPermission(ftdi)
            addLog("USB KKL адаптер найден: VID=0x%04X, PID=0x%04X".format(ftdi.vendorId, ftdi.productId))
        } else {
            tvStatus.text = "Статус: KKL адаптер не найден"
            tvDeviceInfo.text = "Подключите USB-OTG кабель к телефону"
            btnConnectEcu.isEnabled = false
            addLog("Адаптер FT232 / CH340 не обнаружен в системе. Подключите OTG.")
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
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (ACTION_USB_PERMISSION == intent?.action) {
                    try {
                        unregisterReceiver(this)
                    } catch (e: Exception) {}
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (granted) {
                        addLog("Разрешение на работу с USB получено!")
                    } else {
                        addLog("Предупреждение: Разрешение на USB было отклонено.")
                    }
                }
            }
        }

        ContextCompat.registerReceiver(
            this,
            receiver,
            filter,
            ContextCompat.RECEIVER_EXPORTED
        )

        usbManager.requestPermission(device, permissionIntent)
    }

    private fun connectToEcu() {
        val dev = foundDevice ?: return
        lifecycleScope.launch {
            btnConnectEcu.isEnabled = false
            tvStatus.text = "Статус: Открытие порта..."
            val driver = Ftdi5BaudDriver(usbManager, dev)
            if (driver.open()) {
                kwDriver = driver
                tvStatus.text = "Статус: Инициализация 5 бод..."
                val protocol = Kw1281Protocol(driver)
                kwProtocol = protocol
                val success = protocol.connect { msg -> addLog(msg) }
                if (success) {
                    tvStatus.text = "ЭБУ подключен: ${protocol.ecuPartNumber}"
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
            val faults = protocol.readFaultCodes { msg -> addLog(msg) }
            if (faults.isEmpty()) {
                addLog("Ошибки в памяти ЭБУ не обнаружены (00000).")
            } else {
                addLog("Найдено ошибок: ${faults.size}. Коды: ${faults.joinToString()}")
            }
        }
    }

    private fun clearFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            val success = protocol.clearFaultCodes { msg -> addLog(msg) }
            if (success) {
                addLog("Память ошибок ЭБУ успешно очищена!")
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        kwDriver?.close()
    }
}
