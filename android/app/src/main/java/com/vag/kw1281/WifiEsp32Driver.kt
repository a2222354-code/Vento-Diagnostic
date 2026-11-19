package com.vag.kw1281

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.ArrayDeque

/**
 * Wi-Fi TCP драйвер для связи с ESP32-S3, к которому по USB подключён KKL-кабель.
 *
 * Бинарный протокол поверх TCP (порт по умолчанию 3333, TCP_NODELAY):
 * Запросы Android -> ESP32:
 *   [0xAA, 0x01, addr, baudHi, baudLo]  -> 5-бодовая инициализация на стороне ESP32
 *   [0xAA, 0x02, len, data...]          -> Отправка байтов в USB KKL (1..240 байт)
 *   [0xAA, 0x03]                        -> Очистка USB/UART буферов
 *   [0xAA, 0x04]                        -> Запрос статуса подключённого USB KKL кабеля
 *
 * Ответы ESP32 -> Android:
 *   [0xAA, 0x81, status, errCode]       -> Результат 5-бодовой инициализации (1=OK, 0=ERR)
 *   [0xAA, 0x82, len, data...]          -> Принятые байты с линии K-Line
 *   [0xAA, 0x84, usbReady, vidH, vidL, pidH, pidL] -> Информация о USB KKL на ESP32
 */
class WifiEsp32Driver(
    private val host: String,
    private val port: Int = 3333
) : KLineTransport {

    data class Esp32UsbInfo(
        val usbReady: Boolean,
        val vendorId: Int,
        val productId: Int
    )

    private var socket: Socket? = null
    private var outputStream: OutputStream? = null
    private var readerJob: Job? = null
    private val driverScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val rxQueue = ArrayDeque<Byte>()
    private val rxSignal = Channel<Unit>(Channel.CONFLATED)
    private val writeLock = Any()

    @Volatile
    private var pending5BaudResult: CompletableDeferred<Pair<Boolean, Int>>? = null

    @Volatile
    private var pendingInfoResult: CompletableDeferred<Esp32UsbInfo>? = null

    override var lastError: String? = null
        private set

    override val isOpen: Boolean
        get() = socket?.let { it.isConnected && !it.isClosed } == true

    companion object {
        private const val MAGIC = 0xAA
        private const val CMD_5BAUD_INIT = 0x01
        private const val CMD_TX_DATA = 0x02
        private const val CMD_CLEAR_BUF = 0x03
        private const val CMD_PING_INFO = 0x04

        private const val RSP_5BAUD_DONE = 0x81
        private const val RSP_RX_DATA = 0x82
        private const val RSP_INFO = 0x84
    }

    suspend fun open(): Boolean = withContext(Dispatchers.IO) {
        try {
            close()
            lastError = null

            val s = Socket()
            s.tcpNoDelay = true
            s.keepAlive = true
            s.connect(InetSocketAddress(host, port), 3500)

            socket = s
            outputStream = s.getOutputStream()

            val input = BufferedInputStream(s.getInputStream(), 2048)
            readerJob = driverScope.launch {
                readLoop(input)
            }
            true
        } catch (t: Throwable) {
            lastError = "Не удалось подключиться к ESP32 ($host:$port): ${t.message ?: t.javaClass.simpleName}"
            close()
            false
        }
    }

    private suspend fun readLoop(input: BufferedInputStream) {
        try {
            while (driverScope.isActive && isOpen) {
                val b0 = input.read()
                if (b0 < 0) break
                if (b0 != MAGIC) continue

                val type = input.read()
                if (type < 0) break

                when (type) {
                    RSP_RX_DATA -> {
                        val len = input.read()
                        if (len < 0) break
                        if (len > 0) {
                            val buf = ByteArray(len)
                            var offset = 0
                            while (offset < len) {
                                val r = input.read(buf, offset, len - offset)
                                if (r < 0) return
                                offset += r
                            }
                            synchronized(rxQueue) {
                                for (byteVal in buf) {
                                    rxQueue.addLast(byteVal)
                                }
                            }
                            rxSignal.trySend(Unit)
                        }
                    }
                    RSP_5BAUD_DONE -> {
                        val status = input.read()
                        val err = input.read()
                        if (status < 0 || err < 0) break
                        pending5BaudResult?.complete((status == 1) to err)
                    }
                    RSP_INFO -> {
                        val ready = input.read()
                        val vh = input.read()
                        val vl = input.read()
                        val ph = input.read()
                        val pl = input.read()
                        if (ready < 0 || vh < 0 || vl < 0 || ph < 0 || pl < 0) break
                        val vid = ((vh and 0xFF) shl 8) or (vl and 0xFF)
                        val pid = ((ph and 0xFF) shl 8) or (pl and 0xFF)
                        pendingInfoResult?.complete(Esp32UsbInfo(ready == 1, vid, pid))
                    }
                }
            }
        } catch (t: Throwable) {
            lastError = "Разрыв Wi-Fi соединения с ESP32: ${t.message ?: t.javaClass.simpleName}"
        } finally {
            pending5BaudResult?.complete(false to 0xFE)
            pendingInfoResult?.cancel()
            rxSignal.trySend(Unit)
        }
    }

    private fun sendFrame(frame: ByteArray): Boolean {
        val out = outputStream ?: return false
        return try {
            synchronized(writeLock) {
                out.write(frame)
                out.flush()
            }
            true
        } catch (t: Throwable) {
            lastError = "Ошибка отправки в ESP32: ${t.message}"
            false
        }
    }

    suspend fun queryAdapterInfo(timeoutMs: Int = 1500): Esp32UsbInfo? = withContext(Dispatchers.IO) {
        if (!isOpen) return@withContext null
        val deferred = CompletableDeferred<Esp32UsbInfo>()
        pendingInfoResult = deferred
        if (!sendFrame(byteArrayOf(MAGIC.toByte(), CMD_PING_INFO.toByte()))) {
            pendingInfoResult = null
            return@withContext null
        }
        val info = withTimeoutOrNull(timeoutMs.toLong()) { deferred.await() }
        pendingInfoResult = null
        info
    }

    override suspend fun send5BaudInitAddress(
        address: Int,
        targetBaud: Int,
        onLog: (String) -> Unit
    ): Boolean = withContext(Dispatchers.IO) {
        if (!isOpen) {
            lastError = "Wi-Fi соединение с ESP32 закрыто"
            return@withContext false
        }

        synchronized(rxQueue) {
            rxQueue.clear()
        }

        onLog("Wi-Fi ESP32: запуск 5-бодовой инициализации (0x%02X -> %d бод)...".format(address, targetBaud))
        val deferred = CompletableDeferred<Pair<Boolean, Int>>()
        pending5BaudResult = deferred

        val frame = byteArrayOf(
            MAGIC.toByte(),
            CMD_5BAUD_INIT.toByte(),
            (address and 0xFF).toByte(),
            ((targetBaud shr 8) and 0xFF).toByte(),
            (targetBaud and 0xFF).toByte()
        )
        if (!sendFrame(frame)) {
            pending5BaudResult = null
            return@withContext false
        }

        val res = withTimeoutOrNull(4500L) { deferred.await() }
        pending5BaudResult = null

        if (res == null) {
            lastError = "Таймаут 5-бодовой инициализации на ESP32"
            return@withContext false
        }
        if (!res.first) {
            lastError = when (res.second) {
                1 -> "USB KKL кабель не подключён к порту USB-OTG платы ESP32"
                2 -> "Неподдерживаемый USB-UART адаптер в ESP32"
                else -> "Ошибка 5-бодовой посылки на ESP32 (код ${res.second})"
            }
            return@withContext false
        }
        true
    }

    private fun unreadByte(b: Int) {
        synchronized(rxQueue) {
            rxQueue.addFirst((b and 0xFF).toByte())
        }
        rxSignal.trySend(Unit)
    }

    override suspend fun readByte(timeoutMs: Int): Int = withContext(Dispatchers.IO) {
        synchronized(rxQueue) {
            if (rxQueue.isNotEmpty()) {
                return@withContext rxQueue.removeFirst().toInt() and 0xFF
            }
        }
        if (!isOpen) return@withContext -1

        val deadline = System.currentTimeMillis() + timeoutMs
        while (isOpen) {
            val remaining = deadline - System.currentTimeMillis()
            if (remaining <= 0) break

            withTimeoutOrNull(remaining) {
                rxSignal.receive()
            }

            synchronized(rxQueue) {
                if (rxQueue.isNotEmpty()) {
                    return@withContext rxQueue.removeFirst().toInt() and 0xFF
                }
            }
        }
        -1
    }

    override suspend fun writeByteAndVerifyAck(
        b: Byte,
        timeoutMs: Int,
        maxRetries: Int
    ): Boolean = withContext(Dispatchers.IO) {
        if (!isOpen) return@withContext false
        val sentVal = b.toInt() and 0xFF
        val compExpected = (sentVal xor 0xFF) and 0xFF
        val wifiTimeout = maxOf(timeoutMs, 450)

        for (attempt in 1..maxRetries) {
            val frame = byteArrayOf(MAGIC.toByte(), CMD_TX_DATA.toByte(), 1, b)
            if (!sendFrame(frame)) return@withContext false

            val start = System.currentTimeMillis()
            var gotEcho = false

            while (true) {
                val remaining = (wifiTimeout - (System.currentTimeMillis() - start)).toInt()
                if (remaining <= 0) break

                val rx = readByte(remaining)
                if (rx < 0) break

                if (!gotEcho && rx == sentVal) {
                    gotEcho = true
                    continue
                }
                if (rx == compExpected) {
                    delay(2)
                    return@withContext true
                }
                if (rx == sentVal) {
                    continue
                }
            }
            delay(5)
        }
        false
    }

    override suspend fun sendEndMarker(timeoutMs: Int) = withContext(Dispatchers.IO) {
        if (!isOpen) return@withContext
        val frame = byteArrayOf(MAGIC.toByte(), CMD_TX_DATA.toByte(), 1, 0x03)
        if (sendFrame(frame)) {
            val rx = readByte(45)
            if (rx >= 0 && rx != 0x03) {
                unreadByte(rx)
            }
            delay(5)
        }
    }

    override suspend fun writeRawByte(b: Byte, timeoutMs: Int) = withContext(Dispatchers.IO) {
        if (!isOpen) return@withContext
        val sentVal = b.toInt() and 0xFF
        val frame = byteArrayOf(MAGIC.toByte(), CMD_TX_DATA.toByte(), 1, b)
        if (sendFrame(frame)) {
            val rx = readByte(45)
            if (rx >= 0 && rx != sentVal) {
                unreadByte(rx)
            }
        }
    }

    override fun clearBuffers() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
        if (isOpen) {
            driverScope.launch {
                sendFrame(byteArrayOf(MAGIC.toByte(), CMD_CLEAR_BUF.toByte()))
            }
        }
    }

    override fun close() {
        synchronized(rxQueue) {
            rxQueue.clear()
        }
        pending5BaudResult?.cancel()
        pending5BaudResult = null
        pendingInfoResult?.cancel()
        pendingInfoResult = null
        try {
            readerJob?.cancel()
        } catch (_: Throwable) {}
        readerJob = null
        try {
            socket?.close()
        } catch (_: Throwable) {}
        socket = null
        outputStream = null
    }
}
