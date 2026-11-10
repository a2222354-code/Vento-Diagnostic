package com.vag.kw1281

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.hoho.android.usbserial.driver.FtdiSerialDriver
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Решение проблемы 5 бод на FTDI FT232:
 * Стандартный драйвер FTDI не поддерживает скорость ниже 183 бод.
 * Инициализация ЭБУ адресом 0x01 (Двигатель) выполняется через управление
 * линией передачи (UART BREAK) с точными таймингами по 200 мс на бит.
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

    suspend fun open(): Boolean = withContext(Dispatchers.IO) {
        connection = usbManager.openDevice(device) ?: return@withContext false
        val driver = UsbSerialProber.getDefaultProber().probeDevice(device) ?: FtdiSerialDriver(device)
        if (driver.ports.isEmpty()) return@withContext false
        port = driver.ports[0]
        port?.open(connection)
        
        port?.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
        true
    }

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
            val parityBit = if (onesCount % 2 == 1) 0 else 1
            p.setBreak(parityBit == 0)
            Thread.sleep(BIT_TIME_MS)

            // 4. Стоп-бит: Mark (1) -> Break = false
            p.setBreak(false)
            Thread.sleep(BIT_TIME_MS)

            onLog("5-бодовая посылка завершена (2000 мс). Переключение на 9600 бод...")

            p.setParameters(9600, 8, UsbSerialPort.STOPBITS_1, UsbSerialPort.PARITY_NONE)
            true
        } catch (e: Exception) {
            onLog("Ошибка 5-бодовой посылки: ${e.message}")
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
