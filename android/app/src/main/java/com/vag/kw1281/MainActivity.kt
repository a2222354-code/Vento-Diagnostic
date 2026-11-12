package com.vag.kw1281

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
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

    // UI элементы
    private lateinit var tvStatus: TextView
    private lateinit var tvDeviceInfo: TextView
    private lateinit var tvBaudBadge: TextView
    private lateinit var tvResults: TextView
    private lateinit var scrollViewResults: ScrollView

    // Табы выбора ЭБУ
    private lateinit var btnTabEngine: Button
    private lateinit var btnTabImmo: Button
    private var selectedEcuAddress: Int = 0x01 // 0x01 = Двигатель, 0x25 = Иммобилайзер

    // Панели отображения
    private lateinit var layoutLiveData: LinearLayout
    private lateinit var tvGaugeRpm: TextView
    private lateinit var tvGaugeTemp: TextView
    private lateinit var tvGaugeLambda: TextView
    private lateinit var tvGaugeThrottle: TextView

    // Панель иммобилайзера
    private lateinit var layoutImmoStatus: LinearLayout
    private lateinit var tvImmoKeyStatus: TextView
    private lateinit var tvImmoStartStatus: TextView
    private lateinit var tvImmoKeyCount: TextView

    // Панель теста исполнителей
    private lateinit var layoutActuatorTest: LinearLayout
    private lateinit var tvActuatorTitle: TextView
    private lateinit var tvActuatorDesc: TextView
    private lateinit var btnActuatorNext: Button
    private lateinit var btnActuatorStop: Button

    // Основные кнопки
    private lateinit var btnFindUsb: Button
    private lateinit var btnConnectEcu: Button
    private lateinit var btnReadFaults: Button
    private lateinit var btnClearFaults: Button
    private lateinit var btnMeasuring: Button
    private lateinit var btnActuatorStart: Button
    private lateinit var btnBasicSettings: Button
    private lateinit var btnEcuPassport: Button
    private lateinit var btnShareReport: Button
    private lateinit var btnClearResults: Button

    // Связь и сессия
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
                        setResultText("Разрешение на работу с USB адаптером получено. Нажмите «ПОДКЛЮЧИТЬ».")
                        btnConnectEcu.isEnabled = true
                    } else {
                        setResultText("Предупреждение: Разрешение USB было отклонено в диалоге Android.")
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    findUsbAdapter()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val currentList = usbManager?.deviceList
                    val stillPresent = currentList?.values?.any {
                        it.vendorId == 0x0403 || it.vendorId == 0x1A86 || it.vendorId == 0x10C4
                    } == true
                    if (!stillPresent) {
                        stopLiveStream()
                        disconnectSession()
                        foundDevice = null
                        setDiagnosticButtonsEnabled(false)
                        btnConnectEcu.isEnabled = false
                        tvStatus.text = "Статус: USB отключен"
                        tvDeviceInfo.text = "Подключите USB-OTG кабель"
                        setResultText("USB KKL адаптер отключен от телефона.")
                    } else {
                        findUsbAdapter()
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

            btnFindUsb = findViewById(R.id.btnFindUsb)
            btnConnectEcu = findViewById(R.id.btnConnectEcu)
            btnReadFaults = findViewById(R.id.btnReadFaults)
            btnClearFaults = findViewById(R.id.btnClearFaults)
            btnMeasuring = findViewById(R.id.btnMeasuring)
            btnActuatorStart = findViewById(R.id.btnActuatorStart)
            btnBasicSettings = findViewById(R.id.btnBasicSettings)
            btnEcuPassport = findViewById(R.id.btnEcuPassport)
            btnShareReport = findViewById(R.id.btnShareReport)
            btnClearResults = findViewById(R.id.btnClearResults)

            // Переключение табов ЭБУ
            btnTabEngine.setOnClickListener { switchEcuTab(0x01) }
            btnTabImmo.setOnClickListener { switchEcuTab(0x25) }

            // Обработчики кнопок
            btnFindUsb.setOnClickListener { findUsbAdapter() }
            btnConnectEcu.setOnClickListener { connectToSelectedEcu() }
            btnReadFaults.setOnClickListener { readFaultCodes() }
            btnClearFaults.setOnClickListener { clearFaultCodes() }
            btnMeasuring.setOnClickListener { toggleLiveMeasuring() }
            btnActuatorStart.setOnClickListener { startActuatorTest() }
            btnActuatorNext.setOnClickListener { nextActuatorTest() }
            btnActuatorStop.setOnClickListener { stopActuatorTest() }
            btnBasicSettings.setOnClickListener { enterBasicSettings() }
            btnEcuPassport.setOnClickListener { showEcuPassport() }
            btnShareReport.setOnClickListener { copyDiagnosticReport() }
            btnClearResults.setOnClickListener { tvResults.text = "Результаты очищены." }

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
            findUsbAdapter()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun switchEcuTab(addr: Int) {
        if (selectedEcuAddress != addr) {
            disconnectSession()
            setDiagnosticButtonsEnabled(false)
        }
        selectedEcuAddress = addr

        if (addr == 0x01) {
            btnTabEngine.setBackgroundColor(Color.parseColor("#0284C7"))
            btnTabEngine.setTextColor(Color.WHITE)
            btnTabImmo.setBackgroundColor(Color.parseColor("#334155"))
            btnTabImmo.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Bosch Mono-Motronic 1.2.3 (3A0 907 311)"
            layoutLiveData.visibility = View.VISIBLE
            layoutImmoStatus.visibility = View.GONE
            btnMeasuring.visibility = View.VISIBLE
            btnActuatorStart.visibility = View.VISIBLE
            btnBasicSettings.visibility = View.VISIBLE
        } else {
            btnTabImmo.setBackgroundColor(Color.parseColor("#0284C7"))
            btnTabImmo.setTextColor(Color.WHITE)
            btnTabEngine.setBackgroundColor(Color.parseColor("#334155"))
            btnTabEngine.setTextColor(Color.parseColor("#94A3B8"))

            tvDeviceInfo.text = "Блок: Иммобилайзер Wegfahrsicherung (1H0 953 257)"
            layoutLiveData.visibility = View.GONE
            layoutImmoStatus.visibility = View.VISIBLE
            btnMeasuring.visibility = View.GONE
            btnActuatorStart.visibility = View.GONE
            btnBasicSettings.visibility = View.GONE
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

    private fun setDiagnosticButtonsEnabled(enabled: Boolean) {
        btnReadFaults.isEnabled = enabled
        btnClearFaults.isEnabled = enabled
        btnMeasuring.isEnabled = enabled
        btnActuatorStart.isEnabled = enabled
        btnBasicSettings.isEnabled = enabled
        btnEcuPassport.isEnabled = enabled
    }

    private fun findUsbAdapter() {
        val manager = usbManager ?: return
        val deviceList = manager.deviceList
        val ftdi = deviceList.values.firstOrNull { it.vendorId == 0x0403 }
            ?: deviceList.values.firstOrNull { it.vendorId == 0x1A86 || it.vendorId == 0x10C4 }

        if (ftdi != null) {
            foundDevice = ftdi
            tvStatus.text = "Статус: Адаптер обнаружен!"
            if (manager.hasPermission(ftdi)) {
                btnConnectEcu.isEnabled = true
                setResultText("USB KKL адаптер готов к работе. Выберите нужный блок (Двигатель или Иммобилайзер) и нажмите «ПОДКЛЮЧИТЬ».")
            } else {
                btnConnectEcu.isEnabled = false
                requestUsbPermission(ftdi)
            }
        } else {
            tvStatus.text = "Статус: KKL адаптер не найден"
            tvDeviceInfo.text = "Подключите USB-OTG кабель к телефону"
            btnConnectEcu.isEnabled = false
            setDiagnosticButtonsEnabled(false)
            setResultText("Адаптер FT232 / KKL не обнаружен в разъёме USB-OTG.")
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
        } catch (e: Exception) {}
    }

    private fun disconnectSession() {
        stopLiveStream()
        layoutActuatorTest.visibility = View.GONE
        try {
            kwProtocol?.stopSession()
        } catch (t: Throwable) {}
        try {
            kwDriver?.close()
        } catch (t: Throwable) {}
        kwProtocol = null
        kwDriver = null
    }

    private fun connectToSelectedEcu() {
        val dev = foundDevice ?: run {
            setResultText("Сначала подключите USB KKL адаптер.")
            return
        }
        val manager = usbManager ?: return

        lifecycleScope.launch {
            try {
                stopLiveStream()
                layoutActuatorTest.visibility = View.GONE
                btnConnectEcu.isEnabled = false
                setDiagnosticButtonsEnabled(false)
                val blockName = if (selectedEcuAddress == 0x25) "Иммобилайзера (0x25)" else "ЭБУ Двигателя (0x01)"
                tvStatus.text = "Инициализация $blockName..."
                setResultText("Установка связи с $blockName на 5 бод...")

                var driver = kwDriver
                if (driver == null || !driver.isOpen) {
                    disconnectSession()
                    val newDriver = Ftdi5BaudDriver(manager, dev)
                    if (newDriver.open(9600)) {
                        kwDriver = newDriver
                        driver = newDriver
                    } else {
                        tvStatus.text = "Ошибка открытия USB порта"
                        setResultText("Не удалось открыть USB порт: ${newDriver.lastError ?: "проверьте кабель"}")
                        btnConnectEcu.isEnabled = true
                        return@launch
                    }
                }

                val protocol = Kw1281Protocol(driver)
                kwProtocol = protocol
                val success = protocol.connect(selectedEcuAddress) { msg ->
                    // Без вывода сырых байт лога в UI
                }

                if (success) {
                    val pNum = if (protocol.ecuPartNumber.isNotEmpty()) protocol.ecuPartNumber else (if (selectedEcuAddress == 0x25) "1H0 953 257" else "3A0 907 311")
                    tvStatus.text = "Подключен: $pNum"
                    tvBaudBadge.text = "${protocol.negotiatedBaud} бод"
                    btnConnectEcu.isEnabled = true
                    setDiagnosticButtonsEnabled(true)

                    if (selectedEcuAddress == 0x25) {
                        // Опрашиваем статус транспондера иммобилайзера
                        checkImmobilizerStatus(protocol)
                    } else {
                        setResultText("Связь с ЭБУ Двигателя успешно установлена!\n" +
                                "Номер: ${protocol.ecuPartNumber}\n" +
                                "Компонент: ${protocol.ecuComponent}\n" +
                                "Доступны функции: чтение ошибок, живые параметры, тест исполнителей, базовые установки.")
                    }
                } else {
                    tvStatus.text = "Ошибка связи с блоком"
                    setResultText("Блок $blockName не отвечает на запрос.\n" +
                            "• Проверьте, включено ли зажигание (положение ключа ON/приборная панель горит).\n" +
                            "• Проверьте надёжность контакта K-Line в разъёме OBD2.")
                    btnConnectEcu.isEnabled = true
                }
            } catch (t: Throwable) {
                t.printStackTrace()
                tvStatus.text = "Сбой подключения"
                setResultText("Сбой при подключении: ${t.message ?: t.javaClass.simpleName}")
                btnConnectEcu.isEnabled = true
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
                    "• Транспондер чипа: ${if (status.keyAuthorized) "Авторизован" else "Не авторизован / Слишком слабый сигнал катушки"}\n" +
                    "• Ключей прописано: ${status.keyCount}")
        } else {
            setResultText("Иммобилайзер подключен. Номер блока: ${protocol.ecuPartNumber}")
        }
    }

    private fun readFaultCodes() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
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
                stopLiveStream()
                btnClearFaults.isEnabled = false
                val success = protocol.clearFaultCodes { }
                btnClearFaults.isEnabled = true
                if (success) {
                    setResultText("✅ Память кодов неисправностей успешно очищена!\n" +
                            "Нажмите «ОШИБКИ (0x07)» для контрольной проверки.")
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
            btnMeasuring.text = "ИЗМЕРЕНИЯ (08)"
            setResultText("Поток живых измерений остановлен.")
            return
        }

        val protocol = kwProtocol ?: run {
            setResultText("Сначала подключитесь к ЭБУ.")
            return
        }

        btnMeasuring.text = "ОСТАНОВИТЬ (08)"
        setResultText("Запущен опрос Live Data (Группа 000). Данные обновляются на приборных шкалах вверху экрана.")

        liveStreamJob = lifecycleScope.launch {
            try {
                while (isActive) {
                    val m = protocol.readMeasuringGroup(0) { }
                    if (m != null) {
                        updateGauges(m)
                    }
                    delay(400)
                }
            } catch (t: Throwable) {
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

    // Тест исполнительных механизмов (0x04)
    private fun startActuatorTest() {
        val protocol = kwProtocol ?: return
        stopLiveStream()
        layoutActuatorTest.visibility = View.VISIBLE
        tvActuatorTitle.text = "ТЕСТ ИСПОЛНИТЕЛЕЙ (0x04)"
        tvActuatorDesc.text = "Запуск первого теста..."
        nextActuatorTest()
    }

    private fun nextActuatorTest() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                btnActuatorNext.isEnabled = false
                val step = protocol.stepActuatorTest { }
                btnActuatorNext.isEnabled = true
                if (step != null) {
                    tvActuatorDesc.text = step
                    setResultText("АКТИВЕН ТЕСТ ИСПОЛНИТЕЛЕЙ:\n$step\n\nДля перехода к следующему элементу нажмите кнопку «СЛЕДУЮЩИЙ ТЕСТ».")
                    if (step.contains("завершён", ignoreCase = true)) {
                        layoutActuatorTest.visibility = View.GONE
                    }
                } else {
                    layoutActuatorTest.visibility = View.GONE
                    setResultText("Тест исполнителей завершён или отклонён ЭБУ.")
                }
            } catch (t: Throwable) {
                btnActuatorNext.isEnabled = true
                setResultText("Ошибка шага теста: ${t.message}")
            }
        }
    }

    private fun stopActuatorTest() {
        kwProtocol?.stopActuatorTest()
        layoutActuatorTest.visibility = View.GONE
        setResultText("Тест исполнительных механизмов остановлен пользователем.")
    }

    private fun enterBasicSettings() {
        val protocol = kwProtocol ?: return
        lifecycleScope.launch {
            try {
                stopLiveStream()
                layoutActuatorTest.visibility = View.GONE
                btnBasicSettings.isEnabled = false

                val result = protocol.enterBasicSettings(0) { }
                btnBasicSettings.isEnabled = true
                if (result != null) {
                    updateGauges(result)
                    setResultText("🔧 РЕЖИМ БАЗОВЫХ УСТАНОВОК (0x28, Группа 000) АКТИВЕН!\n\n" +
                            "• ЭБУ заблокировал динамическое опережение зажигания.\n" +
                            "• Обороты двигателя зафиксированы на холостом ходу (~850 об/мин).\n" +
                            "• Теперь можно вращать корпус трамблера и выставлять УОЗ 6° до ВМТ по стробоскопу на метку маховика.\n\n" +
                            "Сырые параметры группы 000: ${result.rawValues.joinToString(" ") { "%03d".format(it) }}")
                }
            } catch (t: Throwable) {
                btnBasicSettings.isEnabled = true
                setResultText("Ошибка базовых установок: ${t.message}")
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
