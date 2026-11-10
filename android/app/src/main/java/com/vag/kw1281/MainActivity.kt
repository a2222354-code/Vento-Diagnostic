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
import androidx.core.content.ContextCompat
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
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context?, intent: Intent?) {
                if (ACTION_USB_PERMISSION == intent?.action) {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    // USB permission granted
                }
            }
        }
        
        ContextCompat.registerReceiver(
            this,
            receiver,
            filter,
            ContextCompat.RECEIVER_NOT_EXPORTED
        )

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
                                    statusText = "ЭБУ подключен: ${protocol.ecuPartNumber}"
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
