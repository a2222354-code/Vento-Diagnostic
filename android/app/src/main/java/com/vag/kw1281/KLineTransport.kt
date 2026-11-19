package com.vag.kw1281

/**
 * Общий транспортный интерфейс шины K-Line для протокола KWP1281.
 * Позволяет работать как напрямую через USB-OTG (FTDI/CH340),
 * так и через Wi-Fi мост на базе ESP32 с подключённым USB KKL кабелем.
 */
interface KLineTransport {
    val isOpen: Boolean
    val lastError: String?

    suspend fun send5BaudInitAddress(
        address: Int = 0x01,
        targetBaud: Int = 9600,
        onLog: (String) -> Unit
    ): Boolean

    suspend fun readByte(timeoutMs: Int): Int

    suspend fun writeByteAndVerifyAck(
        b: Byte,
        timeoutMs: Int = 300,
        maxRetries: Int = 4
    ): Boolean

    suspend fun sendEndMarker(timeoutMs: Int = 300)

    suspend fun writeRawByte(b: Byte, timeoutMs: Int = 300)

    fun clearBuffers()

    fun close()
}
