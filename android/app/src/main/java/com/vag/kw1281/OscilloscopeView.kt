package com.vag.kw1281

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Многоканальный автомобильный осциллограф реального времени для VAG KWP1281.
 * Отображает одновременно произвольный набор датчиков с авто-масштабированием по каждому каналу
 * и цифровой ступенчатой кривой для концевика ДЗ (F60).
 */
class OscilloscopeView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0
) : View(context, attrs, defStyleAttr) {

    enum class SensorChannel(
        val label: String,
        val unit: String,
        val colorInt: Int,
        val minSpan: Float,
        val isDigital: Boolean = false
    ) {
        RPM("Обороты", "об/мин", Color.parseColor("#38BDF8"), 1000f),
        COOLANT("ДТОЖ G62", "°C", Color.parseColor("#F59E0B"), 20f),
        LAMBDA("Лямбда G39", "", Color.parseColor("#10B981"), 1.0f),
        THROTTLE("ДПДЗ G69", "°", Color.parseColor("#EC4899"), 15f),
        BATTERY("АКБ", "В", Color.parseColor("#A78BFA"), 2.0f),
        INJECTION("Впрыск", "мс", Color.parseColor("#2DD4BF"), 4.0f),
        AIR_TEMP("ДТВВ G42", "°C", Color.parseColor("#FB923C"), 20f),
        TIMING("УОЗ", "°", Color.parseColor("#FACC15"), 15f),
        LOAD("Нагрузка", "%", Color.parseColor("#60A5FA"), 25f),
        IDLE_SWITCH("Конц. F60", "", Color.parseColor("#34D399"), 1.2f, isDigital = true)
    }

    data class Sample(
        val timestampMs: Long,
        val value: Float
    )

    private val history = LinkedHashMap<SensorChannel, ArrayList<Sample>>()
    private var activeChannels: List<SensorChannel> = listOf(SensorChannel.RPM, SensorChannel.LAMBDA)
    private var timeWindowMs: Long = 30_000L
    private var isPaused: Boolean = false
    private var frozenNowMs: Long = System.currentTimeMillis()
    private var lambdaUnitLabel: String = "В"

    private val density = resources.displayMetrics.density

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#020617")
        style = Paint.Style.FILL
    }

    private val gridPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#1E293B")
        strokeWidth = 1f * density
        style = Paint.Style.STROKE
        pathEffect = DashPathEffect(floatArrayOf(4f * density, 4f * density), 0f)
    }

    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#334155")
        strokeWidth = 1.2f * density
        style = Paint.Style.STROKE
    }

    private val axisTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#64748B")
        textSize = 10f * density
        isFakeBoldText = true
    }

    private val emptyTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#94A3B8")
        textSize = 12f * density
        textAlign = Paint.Align.CENTER
    }

    private val tracePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeWidth = 2.3f * density
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    private val legendBgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(195, 15, 23, 42)
        style = Paint.Style.FILL
    }

    private val legendTextPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 10.5f * density
        isFakeBoldText = true
    }

    private val tracePath = Path()
    private val legendRect = RectF()

    init {
        for (ch in SensorChannel.values()) {
            history[ch] = ArrayList(256)
        }
    }

    fun setActiveChannels(channels: Collection<SensorChannel>) {
        activeChannels = SensorChannel.values().filter { channels.contains(it) }
        invalidate()
    }

    fun setLambdaUnitLabel(unit: String) {
        lambdaUnitLabel = unit
    }

    fun setPaused(paused: Boolean) {
        if (paused && !isPaused) {
            frozenNowMs = System.currentTimeMillis()
        }
        isPaused = paused
        invalidate()
    }

    fun isPausedState(): Boolean = isPaused

    fun setTimeWindowMs(windowMs: Long) {
        timeWindowMs = windowMs.coerceIn(10_000L, 120_000L)
        invalidate()
    }

    fun getTimeWindowSeconds(): Int = (timeWindowMs / 1000L).toInt()

    fun clearSamples() {
        for (list in history.values) {
            list.clear()
        }
        frozenNowMs = System.currentTimeMillis()
        invalidate()
    }

    fun appendSample(timestampMs: Long, values: Map<SensorChannel, Float>) {
        val cutoff = timestampMs - 130_000L
        for ((ch, v) in values) {
            val list = history[ch] ?: continue
            list.add(Sample(timestampMs, v))
            while (list.size > 500 || (list.isNotEmpty() && list[0].timestampMs < cutoff)) {
                list.removeAt(0)
            }
        }
        if (!isPaused) {
            invalidate()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0f || h <= 0f) return

        val padLeft = 8f * density
        val padRight = 10f * density
        val padTop = 8f * density
        val padBottom = 18f * density

        canvas.drawRect(0f, 0f, w, h, bgPaint)

        val plotLeft = padLeft
        val plotRight = w - padRight
        val plotTop = padTop
        val plotBottom = h - padBottom
        val plotW = max(1f, plotRight - plotLeft)
        val plotH = max(1f, plotBottom - plotTop)

        // Горизонтальные линии сетки (4 деления)
        for (i in 0..4) {
            val y = plotTop + (plotH * i / 4f)
            canvas.drawLine(plotLeft, y, plotRight, y, gridPaint)
        }

        // Вертикальные линии сетки времени (6 делений)
        val secsTotal = (timeWindowMs / 1000L).toInt()
        for (i in 0..6) {
            val x = plotLeft + (plotW * i / 6f)
            canvas.drawLine(x, plotTop, x, plotBottom, gridPaint)
            if (i % 2 == 0) {
                val secOffset = -((secsTotal * (6 - i)) / 6)
                val label = if (secOffset == 0) "0с" else "${secOffset}с"
                axisTextPaint.textAlign = when (i) {
                    0 -> Paint.Align.LEFT
                    6 -> Paint.Align.RIGHT
                    else -> Paint.Align.CENTER
                }
                canvas.drawText(label, x, h - 4f * density, axisTextPaint)
            }
        }

        canvas.drawRect(plotLeft, plotTop, plotRight, plotBottom, borderPaint)

        if (activeChannels.isEmpty()) {
            val centerY = plotTop + plotH / 2f - 6f * density
            canvas.drawText(
                "Нажмите на карточку датчика ниже,",
                w / 2f,
                centerY,
                emptyTextPaint
            )
            canvas.drawText(
                "чтобы добавить его на осциллограмму",
                w / 2f,
                centerY + 18f * density,
                emptyTextPaint
            )
            return
        }

        val endTime = if (isPaused) frozenNowMs else System.currentTimeMillis()
        val startTime = endTime - timeWindowMs

        // Отрисовка кривых и расчёт легенды
        val legendEntries = ArrayList<Pair<Int, String>>(activeChannels.size)

        for (ch in activeChannels) {
            val list = history[ch] ?: continue
            val visible = list.filter { it.timestampMs >= startTime - 5_000L && it.timestampMs <= endTime }
            if (visible.isEmpty()) {
                legendEntries.add(ch.colorInt to "${ch.label}: ---")
                continue
            }

            var obsMin = Float.MAX_VALUE
            var obsMax = -Float.MAX_VALUE
            for (s in visible) {
                if (s.value < obsMin) obsMin = s.value
                if (s.value > obsMax) obsMax = s.value
            }

            val yMin: Float
            val yMax: Float
            if (ch.isDigital) {
                yMin = -0.15f
                yMax = 1.25f
            } else {
                val effectiveMinSpan = if (ch == SensorChannel.LAMBDA && abs(obsMax - obsMin) > 2.5f) {
                    20f
                } else {
                    ch.minSpan
                }
                val rawSpan = obsMax - obsMin
                val span = max(rawSpan * 1.18f, effectiveMinSpan)
                val mid = (obsMin + obsMax) / 2f
                yMin = mid - span / 2f
                yMax = mid + span / 2f
            }
            val ySpan = max(0.0001f, yMax - yMin)

            tracePath.reset()
            var lastX = 0f
            var lastY = 0f
            var started = false

            for (s in visible) {
                val normX = ((s.timestampMs - startTime).toFloat() / timeWindowMs.toFloat()).coerceIn(0f, 1f)
                val x = plotLeft + normX * plotW
                val normY = ((s.value - yMin) / ySpan).coerceIn(0f, 1f)
                val y = plotBottom - normY * plotH

                if (!started) {
                    tracePath.moveTo(x, y)
                    started = true
                } else {
                    if (ch.isDigital) {
                        // Прямоугольный фронт для дискретного сигнала концевика F60
                        tracePath.lineTo(x, lastY)
                    }
                    tracePath.lineTo(x, y)
                }
                lastX = x
                lastY = y
            }

            tracePaint.color = ch.colorInt
            canvas.drawPath(tracePath, tracePaint)

            if (started) {
                dotPaint.color = ch.colorInt
                canvas.drawCircle(lastX, lastY, 3.6f * density, dotPaint)
            }

            val latest = visible.last().value
            val legendText = formatLegendValue(ch, latest, obsMin, obsMax)
            legendEntries.add(ch.colorInt to legendText)
        }

        // Компактная легенда в левом верхнем углу экрана осциллографа
        val rowH = 15f * density
        val maxRows = min(legendEntries.size, 6)
        var maxTextW = 0f
        for (i in 0 until maxRows) {
            val tw = legendTextPaint.measureText(legendEntries[i].second)
            if (tw > maxTextW) maxTextW = tw
        }
        val boxPadX = 6f * density
        val boxPadY = 4f * density
        val boxRight = min(plotRight - 4f * density, plotLeft + 18f * density + maxTextW + boxPadX * 2f)
        val boxBottom = min(plotBottom - 4f * density, plotTop + 4f * density + maxRows * rowH + boxPadY * 2f)
        legendRect.set(plotLeft + 4f * density, plotTop + 4f * density, boxRight, boxBottom)
        canvas.drawRoundRect(legendRect, 6f * density, 6f * density, legendBgPaint)

        for (i in 0 until maxRows) {
            val (c, txt) = legendEntries[i]
            val cy = legendRect.top + boxPadY + (i + 0.65f) * rowH
            dotPaint.color = c
            canvas.drawCircle(legendRect.left + boxPadX + 3f * density, cy - 3f * density, 3.2f * density, dotPaint)
            legendTextPaint.color = c
            canvas.drawText(txt, legendRect.left + boxPadX + 10f * density, cy, legendTextPaint)
        }
        if (legendEntries.size > maxRows) {
            // При >6 каналах показываем счётчик оставшихся
            legendTextPaint.color = Color.parseColor("#94A3B8")
            canvas.drawText(
                "+ ещё ${legendEntries.size - maxRows}",
                legendRect.right - 46f * density,
                legendRect.bottom - 4f * density,
                legendTextPaint
            )
        }
    }

    private fun formatLegendValue(
        ch: SensorChannel,
        latest: Float,
        obsMin: Float,
        obsMax: Float
    ): String {
        return when (ch) {
            SensorChannel.RPM -> "${ch.label}: ${latest.toInt()} [${obsMin.toInt()}..${obsMax.toInt()}]"
            SensorChannel.COOLANT,
            SensorChannel.AIR_TEMP -> "${ch.label}: ${latest.toInt()} ${ch.unit}"
            SensorChannel.IDLE_SWITCH -> {
                val st = if (latest >= 0.5f) "ЗАМКН.(ХХ)" else "РАЗОМКН."
                "${ch.label}: $st"
            }
            SensorChannel.LAMBDA -> {
                when (lambdaUnitLabel) {
                    "λ" -> "${ch.label}: ${"%.3f".format(latest)} λ [${"%.3f".format(obsMin)}..${"%.3f".format(obsMax)}]"
                    "В" -> "${ch.label}: ${"%.2f".format(latest)} В [${"%.2f".format(obsMin)}..${"%.2f".format(obsMax)}]"
                    else -> "${ch.label}: ${"%.1f".format(latest)} % [${"%.0f".format(obsMin)}..${"%.0f".format(obsMax)}]"
                }
            }
            SensorChannel.BATTERY,
            SensorChannel.INJECTION -> "${ch.label}: ${"%.2f".format(latest)} ${ch.unit} [${"%.2f".format(obsMin)}..${"%.2f".format(obsMax)}]"
            else -> "${ch.label}: ${"%.1f".format(latest)} ${ch.unit} [${"%.1f".format(obsMin)}..${"%.1f".format(obsMax)}]"
        }
    }
}
