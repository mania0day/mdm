package com.sentroid.agent.game

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import kotlin.math.abs
import kotlin.math.sin
import kotlin.random.Random

/**
 * Endless neon-night runner. Everything is drawn with primitives (no image
 * assets, no game-engine dependency) so it adds no APK weight and no new
 * libraries.
 *
 * Design notes:
 *  - The sky stays dark across every biome and only its hue shifts as the
 *    player levels up. That keeps the pale runner readable at all times, which
 *    a day/night swing would break.
 *  - Difficulty ramps on two independent axes: scroll speed climbs continuously
 *    with distance, while the *variety* of obstacles unlocks in steps by level,
 *    so a new hazard type is introduced on its own before it gets fast.
 *  - Obstacle spacing is measured in frames rather than pixels. Jump airtime is
 *    constant in frames, so a frame-denominated gap stays clearable no matter
 *    how fast the world is scrolling.
 */
class DinoGameView(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    /** Fired once per run, right as the run ends, with the final score. */
    var onGameOver: ((score: Int) -> Unit)? = null

    /** Fired whenever the level advances, so the host can react (haptics etc). */
    var onLevelUp: ((level: Int) -> Unit)? = null

    var bestScore: Int = 0

    /** Current level, exposed for the host activity's HUD. */
    var level: Int = 1
        private set

    private enum class State { READY, RUNNING, OVER }

    private var state = State.READY

    // ---------------------------------------------------------------- biomes

    /**
     * A biome is a full colour scheme. Levels cycle through these, and the
     * transition is interpolated over [BIOME_FADE_FRAMES] rather than cutting,
     * so a level-up reads as the world shifting instead of a flicker.
     */
    private class Biome(
        val name: String,
        val skyTop: Int,
        val skyBottom: Int,
        val mountainFar: Int,
        val mountainNear: Int,
        val ground: Int,
        val accent: Int,
    )

    private val biomes = listOf(
        Biome("MIDNIGHT", 0xFF0B1026.toInt(), 0xFF1E1B4B.toInt(), 0xFF272561.toInt(), 0xFF16143A.toInt(), 0xFF080B1C.toInt(), 0xFF22D3EE.toInt()),
        Biome("EMBER", 0xFF1A0B2E.toInt(), 0xFF4C1D3D.toInt(), 0xFF5B2447.toInt(), 0xFF33132C.toInt(), 0xFF12071F.toInt(), 0xFFFB7185.toInt()),
        Biome("TOXIC", 0xFF041F1A.toInt(), 0xFF0F3D2E.toInt(), 0xFF17513C.toInt(), 0xFF0A2D22.toInt(), 0xFF021512.toInt(), 0xFF4ADE80.toInt()),
        Biome("SOLAR", 0xFF2A1505.toInt(), 0xFF4A2C0A.toInt(), 0xFF5C380D.toInt(), 0xFF321C06.toInt(), 0xFF1C0E03.toInt(), 0xFFFBBF24.toInt()),
        Biome("VIOLET", 0xFF1B0B2E.toInt(), 0xFF3B0764.toInt(), 0xFF4A0B7A.toInt(), 0xFF260845.toInt(), 0xFF120520.toInt(), 0xFFA78BFA.toInt()),
        Biome("ARCTIC", 0xFF04182E.toInt(), 0xFF0C3A5C.toInt(), 0xFF10496F.toInt(), 0xFF072940.toInt(), 0xFF021019.toInt(), 0xFF7DD3FC.toInt()),
    )

    // Colours actually painted this frame — lerped from `fromBiome` to `toBiome`.
    private var fromBiome = biomes[0]
    private var toBiome = biomes[0]
    private var biomeFade = 1f
    private var cSkyTop = 0
    private var cSkyBottom = 0
    private var cMountainFar = 0
    private var cMountainNear = 0
    private var cGround = 0
    private var cAccent = 0

    // ------------------------------------------------------------ world state

    private var groundY = 0f
    private var runnerX = 0f
    private var runnerY = 0f
    private var runnerH = 0f
    private var runnerW = 0f
    private var velocityY = 0f
    private var airborne = false
    private var ducking = false
    private var runCycle = 0f

    private var speed = BASE_SPEED
    private var sizeScale = 1f
    private var scoreAcc = 0f
    private val score get() = scoreAcc.toInt()
    private var lastFrameNs = 0L
    private var worldOffset = 0f
    private var levelBannerFrames = 0f
    private var shake = 0f

    private enum class Kind { GROUND, DUCK_FLYER, LOW_FLYER }

    private class Obstacle(
        var x: Float,
        val w: Float,
        val h: Float,
        /** Distance from the ground line up to the obstacle's *bottom* edge. */
        val baseOffset: Float,
        val kind: Kind,
        /** Number of merged segments — only meaningful for GROUND clusters. */
        val segments: Int,
        val seed: Float,
    )

    private val obstacles = mutableListOf<Obstacle>()
    private var spawnTimer = 0f
    private var nextSpawnAt = 80f

    private class Particle(var x: Float, var y: Float, var vx: Float, var vy: Float, var life: Float, val size: Float)

    private val particles = mutableListOf<Particle>()

    private class Star(val x: Float, val y: Float, val r: Float, val phase: Float)

    private val stars = mutableListOf<Star>()

    // ---------------------------------------------------------------- paints
    // All pre-allocated: onDraw runs every frame and must not allocate.

    private val skyPaint = Paint()
    private val fillPaint = Paint().apply { isAntiAlias = true }
    private val strokePaint = Paint().apply { isAntiAlias = true; style = Paint.Style.STROKE }
    private val glowPaint = Paint().apply { isAntiAlias = true }
    private val hudPaint = Paint().apply { isAntiAlias = true; isFakeBoldText = true }
    private val hudDimPaint = Paint().apply { isAntiAlias = true }
    private val centerPaint = Paint().apply { isAntiAlias = true; textAlign = Paint.Align.CENTER }
    private val centerBoldPaint = Paint().apply { isAntiAlias = true; textAlign = Paint.Align.CENTER; isFakeBoldText = true }
    private val path = Path()
    private val rect = RectF()

    private var hudSize = 0f
    private var titleSize = 0f
    private var bodySize = 0f

    private val loop = object : Runnable {
        override fun run() {
            step()
            invalidate()
            postOnAnimation(this)
        }
    }

    init {
        isClickable = true
        applyBiomeColors()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        lastFrameNs = System.nanoTime()
        postOnAnimation(loop)
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        removeCallbacks(loop)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        sizeScale = w / 1080f
        groundY = h * 0.74f
        runnerH = h * 0.10f
        runnerW = runnerH * 0.86f
        runnerX = w * 0.16f
        runnerY = groundY - runnerH

        hudSize = h * 0.030f
        titleSize = h * 0.055f
        bodySize = h * 0.028f
        hudPaint.textSize = hudSize
        hudDimPaint.textSize = hudSize * 0.82f
        centerPaint.textSize = bodySize
        centerBoldPaint.textSize = titleSize

        skyPaint.shader = LinearGradient(0f, 0f, 0f, groundY, cSkyTop, cSkyBottom, Shader.TileMode.CLAMP)

        stars.clear()
        val rnd = Random(7)
        repeat(46) {
            stars.add(
                Star(
                    rnd.nextFloat() * w,
                    rnd.nextFloat() * groundY * 0.72f,
                    (h * 0.0016f) * (0.5f + rnd.nextFloat()),
                    rnd.nextFloat() * 6.28f,
                ),
            )
        }
    }

    // -------------------------------------------------------------- controls

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (state != State.RUNNING) {
                    startGame()
                } else if (event.y > height * 0.68f) {
                    // Lower band of the screen is the duck control; anywhere
                    // else jumps. Held, not tapped — release stands back up.
                    ducking = true
                    if (airborne) velocityY += gravity() * 6f // slam down out of a jump
                } else if (!airborne) {
                    airborne = true
                    velocityY = jumpVelocity()
                    spawnDust(6)
                }
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> ducking = false
        }
        return true
    }

    /**
     * Gravity and jump impulse are both derived from the runner's height rather
     * than being absolute pixel constants, so the arc is identical on every
     * screen size. With these values the apex lands at ~2x runner height and
     * the airtime is ~40 frames — comfortably clearing the tallest obstacle
     * while staying under [ABSOLUTE_MIN_GAP], which is what guarantees a
     * spawn can always be jumped in time.
     */
    private fun gravity() = runnerH / 100f

    private fun jumpVelocity() = -20f * gravity()

    private fun startGame() {
        obstacles.clear()
        particles.clear()
        scoreAcc = 0f
        speed = BASE_SPEED * sizeScale
        spawnTimer = 0f
        nextSpawnAt = 80f
        runnerY = groundY - runnerH
        velocityY = 0f
        airborne = false
        ducking = false
        level = 1
        fromBiome = biomes[0]
        toBiome = biomes[0]
        biomeFade = 1f
        levelBannerFrames = 0f
        shake = 0f
        applyBiomeColors()
        state = State.RUNNING
    }

    // ----------------------------------------------------------------- update

    /**
     * Advances the simulation, scaled by real elapsed time so the game plays
     * identically on 60Hz, 90Hz and 120Hz panels.
     */
    private fun step() {
        val now = System.nanoTime()
        val dtMs = ((now - lastFrameNs) / 1_000_000f).coerceIn(0f, 50f)
        lastFrameNs = now
        val scale = dtMs / 16.67f

        if (biomeFade < 1f) {
            biomeFade = (biomeFade + scale / BIOME_FADE_FRAMES).coerceAtMost(1f)
            applyBiomeColors()
        }
        if (levelBannerFrames > 0f) levelBannerFrames -= scale
        if (shake > 0f) shake = (shake - scale * 1.4f).coerceAtLeast(0f)

        stepParticles(scale)

        // The world keeps drifting on the ready/game-over screens so the
        // background never looks frozen — only gameplay halts.
        if (state != State.RUNNING) {
            worldOffset += BASE_SPEED * sizeScale * 0.25f * scale
            return
        }

        worldOffset += speed * scale
        runCycle += speed * scale * 0.06f

        // --- runner physics
        val g = if (ducking && airborne) gravity() * 2.4f else gravity()
        if (airborne) {
            velocityY += g * scale
            runnerY += velocityY * scale
            if (runnerY >= groundY - runnerH) {
                runnerY = groundY - runnerH
                airborne = false
                velocityY = 0f
                spawnDust(8)
            }
        }

        // --- difficulty: speed climbs continuously, level unlocks variety
        speed = (BASE_SPEED + scoreAcc * SPEED_PER_POINT).coerceAtMost(MAX_SPEED) * sizeScale
        val newLevel = 1 + (scoreAcc / POINTS_PER_LEVEL).toInt()
        if (newLevel > level) {
            level = newLevel
            fromBiome = currentBlend()
            toBiome = biomes[(level - 1) % biomes.size]
            biomeFade = 0f
            levelBannerFrames = LEVEL_BANNER_FRAMES
            onLevelUp?.invoke(level)
        }

        // --- spawning
        spawnTimer += scale
        if (spawnTimer >= nextSpawnAt) {
            spawnTimer = 0f
            spawnObstacle()
            // Gaps tighten with level but never below the airtime floor, so
            // every spawn stays physically clearable.
            val minGap = (MIN_GAP_FRAMES - level * 1.6f).coerceAtLeast(ABSOLUTE_MIN_GAP)
            val maxGap = (MAX_GAP_FRAMES - level * 2.4f).coerceAtLeast(minGap + 18f)
            nextSpawnAt = minGap + Random.nextFloat() * (maxGap - minGap)
        }

        val iter = obstacles.iterator()
        while (iter.hasNext()) {
            val o = iter.next()
            o.x -= speed * scale
            if (o.x + o.w < 0) iter.remove()
        }

        // --- collision
        val rH = if (ducking && !airborne) runnerH * 0.55f else runnerH
        // Anchor to runnerY while airborne — deriving the box from groundY
        // instead would leave the hitbox on the floor during a jump, so
        // jumping would clear nothing.
        val rTopRaw = if (airborne) runnerY else groundY - rH
        val rBottom = rTopRaw + rH
        // Slight inset so near-misses feel fair rather than cheap.
        val rLeft = runnerX + runnerW * 0.16f
        val rRight = runnerX + runnerW * 0.86f
        val rTop = rTopRaw + rH * 0.10f
        for (o in obstacles) {
            val oTop = groundY - o.baseOffset - o.h
            val oBottom = groundY - o.baseOffset
            if (rRight > o.x && rLeft < o.x + o.w && rBottom > oTop && rTop < oBottom) {
                crash()
                return
            }
        }

        scoreAcc += scale * 0.9f
        if (!airborne && runCycle.toInt() % 7 == 0) spawnDust(1)
    }

    private fun crash() {
        state = State.OVER
        shake = 14f
        if (score > bestScore) bestScore = score
        repeat(22) {
            particles.add(
                Particle(
                    runnerX + runnerW / 2f, runnerY + runnerH / 2f,
                    (Random.nextFloat() - 0.35f) * 9f, (Random.nextFloat() - 0.7f) * 9f,
                    1f, runnerW * (0.06f + Random.nextFloat() * 0.10f),
                ),
            )
        }
        onGameOver?.invoke(score)
    }

    /**
     * Picks an obstacle type from the pool unlocked at the current level, so
     * each new hazard gets introduced in isolation before the pace picks up.
     */
    private fun spawnObstacle() {
        val roll = Random.nextFloat()
        val kind = when {
            level < 3 -> Kind.GROUND
            level < 5 -> if (roll < 0.72f) Kind.GROUND else Kind.DUCK_FLYER
            else -> when {
                roll < 0.56f -> Kind.GROUND
                roll < 0.82f -> Kind.DUCK_FLYER
                else -> Kind.LOW_FLYER
            }
        }
        val seed = Random.nextFloat()
        when (kind) {
            Kind.GROUND -> {
                // Clusters only appear once the player has some speed under them.
                val segments = if (level >= 4 && Random.nextFloat() < 0.30f) Random.nextInt(2, 4) else 1
                val h = runnerH * (0.52f + Random.nextFloat() * 0.46f)
                val w = runnerW * (0.30f + Random.nextFloat() * 0.16f) * segments
                obstacles.add(Obstacle(width + w, w, h, 0f, kind, segments, seed))
            }

            Kind.DUCK_FLYER -> {
                // Sits at head height: only clearable by ducking underneath.
                val h = runnerH * 0.34f
                val w = runnerW * 1.05f
                obstacles.add(Obstacle(width + w, w, h, runnerH * 0.62f, kind, 1, seed))
            }

            Kind.LOW_FLYER -> {
                // Hovers just off the ground: has to be jumped like a wall.
                val h = runnerH * 0.34f
                val w = runnerW * 1.05f
                obstacles.add(Obstacle(width + w, w, h, runnerH * 0.10f, kind, 1, seed))
            }
        }
    }

    private fun spawnDust(n: Int) {
        repeat(n) {
            particles.add(
                Particle(
                    runnerX + runnerW * 0.2f, groundY - runnerH * 0.04f,
                    -speed * (0.25f + Random.nextFloat() * 0.4f), -Random.nextFloat() * 2.4f,
                    1f, runnerW * (0.05f + Random.nextFloat() * 0.07f),
                ),
            )
        }
    }

    private fun stepParticles(scale: Float) {
        val it = particles.iterator()
        while (it.hasNext()) {
            val p = it.next()
            p.x += p.vx * scale
            p.y += p.vy * scale
            p.vy += 0.32f * scale
            p.life -= 0.028f * scale
            if (p.life <= 0f) it.remove()
        }
    }

    // ------------------------------------------------------------- colouring

    private fun lerpColor(a: Int, b: Int, t: Float): Int {
        val inv = 1f - t
        return Color.argb(
            255,
            (Color.red(a) * inv + Color.red(b) * t).toInt(),
            (Color.green(a) * inv + Color.green(b) * t).toInt(),
            (Color.blue(a) * inv + Color.blue(b) * t).toInt(),
        )
    }

    private fun applyBiomeColors() {
        val t = biomeFade
        cSkyTop = lerpColor(fromBiome.skyTop, toBiome.skyTop, t)
        cSkyBottom = lerpColor(fromBiome.skyBottom, toBiome.skyBottom, t)
        cMountainFar = lerpColor(fromBiome.mountainFar, toBiome.mountainFar, t)
        cMountainNear = lerpColor(fromBiome.mountainNear, toBiome.mountainNear, t)
        cGround = lerpColor(fromBiome.ground, toBiome.ground, t)
        cAccent = lerpColor(fromBiome.accent, toBiome.accent, t)
        if (groundY > 0f) {
            skyPaint.shader = LinearGradient(0f, 0f, 0f, groundY, cSkyTop, cSkyBottom, Shader.TileMode.CLAMP)
        }
    }

    /** The blend showing on screen right now, used as the start of the next fade. */
    private fun currentBlend() = Biome(
        toBiome.name, cSkyTop, cSkyBottom, cMountainFar, cMountainNear, cGround, cAccent,
    )

    // ------------------------------------------------------------------ draw

    override fun onDraw(canvas: Canvas) {
        val saved = canvas.save()
        if (shake > 0f) {
            canvas.translate(
                (Random.nextFloat() - 0.5f) * shake,
                (Random.nextFloat() - 0.5f) * shake,
            )
        }

        canvas.drawRect(0f, 0f, width.toFloat(), groundY, skyPaint)
        drawStars(canvas)
        drawMountains(canvas, cMountainFar, 0.18f, groundY * 0.30f, width * 0.42f)
        drawMountains(canvas, cMountainNear, 0.42f, groundY * 0.20f, width * 0.30f)
        drawGround(canvas)
        drawParticles(canvas)
        for (o in obstacles) drawObstacle(canvas, o)
        drawRunner(canvas)

        canvas.restoreToCount(saved)
        drawHud(canvas)
        drawOverlay(canvas)
    }

    private fun drawStars(canvas: Canvas) {
        fillPaint.shader = null
        for (s in stars) {
            // Stars drift far slower than the ground for a parallax depth cue,
            // and breathe slightly so the sky is never completely static.
            var x = s.x - worldOffset * 0.04f
            x = ((x % width) + width) % width
            val twinkle = 0.55f + 0.45f * sin(worldOffset * 0.01f + s.phase)
            fillPaint.color = Color.WHITE
            fillPaint.alpha = (110 * twinkle).toInt().coerceIn(0, 255)
            canvas.drawCircle(x, s.y, s.r, fillPaint)
        }
        fillPaint.alpha = 255
    }

    private fun drawMountains(canvas: Canvas, color: Int, parallax: Float, peakH: Float, spacing: Float) {
        fillPaint.shader = null
        fillPaint.color = color
        val offset = (worldOffset * parallax) % spacing
        path.reset()
        path.moveTo(-spacing, groundY)
        var x = -spacing - offset
        var i = 0
        while (x < width + spacing * 2f) {
            // Deterministic per-peak variation keyed off the index, so the
            // ridgeline is irregular but doesn't churn between frames.
            val vary = 0.55f + abs(sin(i * 12.9898f)) * 0.75f
            path.lineTo(x + spacing / 2f, groundY - peakH * vary)
            path.lineTo(x + spacing, groundY)
            x += spacing
            i++
        }
        path.lineTo(width + spacing * 2f, groundY)
        path.close()
        canvas.drawPath(path, fillPaint)
    }

    private fun drawGround(canvas: Canvas) {
        fillPaint.shader = null
        fillPaint.color = cGround
        canvas.drawRect(0f, groundY, width.toFloat(), height.toFloat(), fillPaint)

        // Neon strip along the horizon, with a soft glow band above it.
        glowPaint.color = cAccent
        glowPaint.alpha = 38
        canvas.drawRect(0f, groundY - runnerH * 0.10f, width.toFloat(), groundY, glowPaint)
        glowPaint.alpha = 255
        strokePaint.color = cAccent
        strokePaint.strokeWidth = height * 0.004f
        canvas.drawLine(0f, groundY, width.toFloat(), groundY, strokePaint)

        // Scrolling tick marks sell the sense of motion on an otherwise flat floor.
        strokePaint.strokeWidth = height * 0.002f
        strokePaint.color = cAccent
        strokePaint.alpha = 70
        val tick = width * 0.09f
        var x = -(worldOffset % tick)
        while (x < width) {
            canvas.drawLine(x, groundY + height * 0.022f, x + tick * 0.34f, groundY + height * 0.022f, strokePaint)
            x += tick
        }
        strokePaint.alpha = 255
    }

    private fun drawParticles(canvas: Canvas) {
        fillPaint.shader = null
        for (p in particles) {
            fillPaint.color = cAccent
            fillPaint.alpha = (160 * p.life).toInt().coerceIn(0, 255)
            canvas.drawCircle(p.x, p.y, p.size * p.life, fillPaint)
        }
        fillPaint.alpha = 255
    }

    private fun drawObstacle(canvas: Canvas, o: Obstacle) {
        fillPaint.shader = null
        val top = groundY - o.baseOffset - o.h
        val bottom = groundY - o.baseOffset

        when (o.kind) {
            Kind.GROUND -> {
                // Glow halo first, then the solid body on top of it.
                glowPaint.color = cAccent
                glowPaint.alpha = 45
                rect.set(o.x - o.w * 0.12f, top - o.h * 0.06f, o.x + o.w * 1.12f, bottom)
                canvas.drawRoundRect(rect, o.w * 0.3f, o.w * 0.3f, glowPaint)
                glowPaint.alpha = 255

                fillPaint.color = cAccent
                val segW = o.w / o.segments
                for (s in 0 until o.segments) {
                    val sx = o.x + s * segW
                    // Middle segments of a cluster are shorter, giving the
                    // silhouette a recognisable cactus profile.
                    val sh = if (o.segments == 1) o.h else o.h * (if (s == 0) 1f else 0.68f + s * 0.08f)
                    rect.set(sx + segW * 0.12f, groundY - sh, sx + segW * 0.88f, bottom)
                    canvas.drawRoundRect(rect, segW * 0.22f, segW * 0.22f, fillPaint)
                }
                fillPaint.color = Color.WHITE
                fillPaint.alpha = 55
                rect.set(o.x + o.w * 0.14f, top + o.h * 0.06f, o.x + o.w * 0.28f, bottom - o.h * 0.1f)
                canvas.drawRoundRect(rect, o.w * 0.1f, o.w * 0.1f, fillPaint)
                fillPaint.alpha = 255
            }

            Kind.DUCK_FLYER, Kind.LOW_FLYER -> {
                // Drone: a lozenge body with wings that flap on a sine.
                val cx = o.x + o.w / 2f
                val cy = top + o.h / 2f
                val flap = sin(worldOffset * 0.09f + o.seed * 6.28f) * o.h * 0.42f

                glowPaint.color = cAccent
                glowPaint.alpha = 45
                canvas.drawCircle(cx, cy, o.h * 0.95f, glowPaint)
                glowPaint.alpha = 255

                fillPaint.color = cAccent
                path.reset()
                path.moveTo(cx - o.w * 0.5f, cy)
                path.lineTo(cx - o.w * 0.1f, cy - o.h * 0.22f + flap)
                path.lineTo(cx + o.w * 0.34f, cy - o.h * 0.12f)
                path.lineTo(cx + o.w * 0.5f, cy)
                path.lineTo(cx + o.w * 0.34f, cy + o.h * 0.12f)
                path.lineTo(cx - o.w * 0.1f, cy + o.h * 0.22f - flap)
                path.close()
                canvas.drawPath(path, fillPaint)

                rect.set(cx - o.w * 0.22f, cy - o.h * 0.30f, cx + o.w * 0.22f, cy + o.h * 0.30f)
                canvas.drawRoundRect(rect, o.h * 0.3f, o.h * 0.3f, fillPaint)

                fillPaint.color = Color.WHITE
                canvas.drawCircle(cx + o.w * 0.10f, cy, o.h * 0.11f, fillPaint)
            }
        }
    }

    private fun drawRunner(canvas: Canvas) {
        fillPaint.shader = null
        val h = if (ducking && !airborne) runnerH * 0.55f else runnerH
        val y = groundY - h
        val w = if (ducking && !airborne) runnerW * 1.25f else runnerW

        // Contact shadow — grounds the character and reads as height when airborne.
        // Measured against the standing rest position so ducking (which changes
        // `h` but not `runnerY`) doesn't read as being off the ground.
        val lift = ((groundY - runnerH - runnerY) / runnerH).coerceIn(0f, 1f)
        fillPaint.color = Color.BLACK
        fillPaint.alpha = (70 * (1f - lift * 0.7f)).toInt()
        canvas.drawOval(
            runnerX + w * 0.05f, groundY - h * 0.06f,
            runnerX + w * 0.95f, groundY + h * 0.07f, fillPaint,
        )
        fillPaint.alpha = 255

        val top = if (airborne) runnerY else y
        // Everything below hangs off the runner's own bottom edge, not the
        // ground line — otherwise the legs stay planted while the body jumps.
        val feetY = top + h

        // Fractional coordinates inside the runner's box, so the whole T-rex is
        // authored once and scales to any screen. x runs 0..1 across `w`,
        // y runs 0..1 from the top of the runner down to its feet.
        fun px(fx: Float) = runnerX + w * fx
        fun py(fy: Float) = top + h * fy

        val swing = if (airborne) 0f else sin(runCycle)
        val legLift = h * 0.10f

        // --- legs (drawn before the body so the torso overlaps the near leg)
        fillPaint.color = LEG_SHADE
        drawLeg(canvas, px(0.30f), feetY, w, h, if (airborne) -0.55f else -swing, legLift)
        fillPaint.color = BODY

        // --- tail + torso + neck + head as one continuous silhouette
        path.reset()
        path.moveTo(px(-0.34f), py(0.50f))                       // tail tip
        path.quadTo(px(-0.08f), py(0.34f), px(0.20f), py(0.34f))  // top of tail into the back
        path.quadTo(px(0.40f), py(0.33f), px(0.52f), py(0.20f))   // shoulders rising to the neck
        path.quadTo(px(0.60f), py(0.06f), px(0.78f), py(0.05f))   // top of the skull
        path.lineTo(px(1.00f), py(0.07f))                         // brow to snout tip
        path.lineTo(px(1.02f), py(0.19f))                         // blunt front of the snout
        path.lineTo(px(0.74f), py(0.22f))                         // upper jaw, underside
        path.lineTo(px(0.72f), py(0.29f))                         // mouth line / chin
        path.quadTo(px(0.62f), py(0.34f), px(0.56f), py(0.46f))   // throat down to the chest
        path.quadTo(px(0.50f), py(0.66f), px(0.34f), py(0.70f))   // belly
        path.quadTo(px(0.10f), py(0.74f), px(-0.06f), py(0.62f))  // haunch into the tail underside
        path.quadTo(px(-0.22f), py(0.60f), px(-0.34f), py(0.50f)) // tail tapering back to the tip
        path.close()
        canvas.drawPath(path, fillPaint)

        // Tiny forearm — the detail that makes the silhouette read as a T-rex.
        rect.set(px(0.52f), py(0.40f), px(0.68f), py(0.48f))
        canvas.drawRoundRect(rect, h * 0.04f, h * 0.04f, fillPaint)

        // --- near leg, over the torso
        drawLeg(canvas, px(0.42f), feetY, w, h, if (airborne) 0.5f else swing, legLift)

        // --- face: accent brow stripe plus an eye that reads at small sizes
        fillPaint.color = cAccent
        rect.set(px(0.80f), py(0.09f), px(1.00f), py(0.14f))
        canvas.drawRoundRect(rect, h * 0.02f, h * 0.02f, fillPaint)
        fillPaint.color = EYE
        canvas.drawCircle(px(0.86f), py(0.17f), h * 0.035f, fillPaint)
        fillPaint.color = Color.WHITE
        canvas.drawCircle(px(0.875f), py(0.163f), h * 0.014f, fillPaint)

        // Mouth line, cut back out of the jaw in the sky colour so it reads as
        // an open mouth rather than a painted-on stripe.
        fillPaint.color = cSkyBottom
        rect.set(px(0.76f), py(0.195f), px(1.00f), py(0.215f))
        canvas.drawRect(rect, fillPaint)
    }

    /**
     * One hind leg: thigh, shin and foot, posed by [phase] in -1..1 where
     * positive swings the leg forward. Drawn with the caller's current paint
     * colour so the far leg can be shaded darker for depth.
     */
    private fun drawLeg(
        canvas: Canvas,
        hipX: Float,
        feetY: Float,
        w: Float,
        h: Float,
        phase: Float,
        lift: Float,
    ) {
        val thighW = w * 0.20f
        val shinW = w * 0.11f
        val hipY = feetY - h * 0.42f
        // Forward swing also lifts the foot, so the stride reads as running
        // rather than sliding.
        val footX = hipX + phase * w * 0.20f
        val footY = feetY - (if (phase > 0f) phase * lift else 0f)

        // Thigh: a chunky wedge from the hip toward the knee.
        val kneeX = hipX + phase * w * 0.09f
        val kneeY = feetY - h * 0.20f
        path.reset()
        path.moveTo(hipX - thighW * 0.5f, hipY)
        path.lineTo(hipX + thighW * 0.6f, hipY)
        path.lineTo(kneeX + shinW * 0.6f, kneeY)
        path.lineTo(kneeX - shinW * 0.7f, kneeY)
        path.close()
        canvas.drawPath(path, fillPaint)

        // Shin
        path.reset()
        path.moveTo(kneeX - shinW * 0.5f, kneeY)
        path.lineTo(kneeX + shinW * 0.5f, kneeY)
        path.lineTo(footX + shinW * 0.4f, footY)
        path.lineTo(footX - shinW * 0.4f, footY)
        path.close()
        canvas.drawPath(path, fillPaint)

        // Foot
        rect.set(footX - shinW * 0.5f, footY - h * 0.035f, footX + w * 0.13f, footY)
        canvas.drawRoundRect(rect, h * 0.018f, h * 0.018f, fillPaint)
    }

    private fun drawHud(canvas: Canvas) {
        hudPaint.color = TEXT
        hudDimPaint.color = TEXT_DIM

        val pad = width * 0.055f
        hudPaint.textAlign = Paint.Align.LEFT
        canvas.drawText(score.toString().padStart(5, '0'), pad, pad + hudSize, hudPaint)

        hudDimPaint.textAlign = Paint.Align.LEFT
        canvas.drawText("BEST ${bestScore.toString().padStart(5, '0')}", pad, pad + hudSize * 2.1f, hudDimPaint)

        // Level chip, right-aligned, in the biome accent.
        hudPaint.textAlign = Paint.Align.RIGHT
        hudPaint.color = cAccent
        canvas.drawText("LV $level", width - pad, pad + hudSize, hudPaint)
        hudDimPaint.textAlign = Paint.Align.RIGHT
        canvas.drawText(toBiome.name, width - pad, pad + hudSize * 2.1f, hudDimPaint)
    }

    private fun drawOverlay(canvas: Canvas) {
        if (levelBannerFrames > 0f && state == State.RUNNING) {
            val t = (levelBannerFrames / LEVEL_BANNER_FRAMES).coerceIn(0f, 1f)
            centerBoldPaint.color = cAccent
            centerBoldPaint.alpha = (255 * t).toInt().coerceIn(0, 255)
            centerBoldPaint.textSize = titleSize * 0.8f
            canvas.drawText("LEVEL $level", width / 2f, height * 0.30f, centerBoldPaint)
            centerPaint.color = cAccent
            centerPaint.alpha = (200 * t).toInt().coerceIn(0, 255)
            canvas.drawText(toBiome.name, width / 2f, height * 0.30f + bodySize * 1.5f, centerPaint)
            centerPaint.alpha = 255
            centerBoldPaint.alpha = 255
            centerBoldPaint.textSize = titleSize
        }

        if (state == State.RUNNING) return

        // Scrim so the menu text stays legible over a busy background.
        fillPaint.shader = null
        fillPaint.color = Color.BLACK
        fillPaint.alpha = 130
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), fillPaint)
        fillPaint.alpha = 255

        val cx = width / 2f
        centerBoldPaint.color = TEXT
        centerPaint.color = TEXT_DIM

        if (state == State.READY) {
            canvas.drawText("SENTROID RUN", cx, height * 0.38f, centerBoldPaint)
            centerPaint.color = cAccent
            canvas.drawText("TAP TO START", cx, height * 0.47f, centerPaint)
            centerPaint.color = TEXT_DIM
            canvas.drawText("Tap upper screen to jump", cx, height * 0.56f, centerPaint)
            canvas.drawText("Hold lower screen to duck", cx, height * 0.56f + bodySize * 1.4f, centerPaint)
        } else {
            canvas.drawText("GAME OVER", cx, height * 0.36f, centerBoldPaint)
            centerPaint.color = TEXT
            canvas.drawText("Score $score  ·  Level $level", cx, height * 0.45f, centerPaint)
            centerPaint.color = if (score >= bestScore && score > 0) cAccent else TEXT_DIM
            val line = if (score >= bestScore && score > 0) "NEW BEST!" else "Best $bestScore"
            canvas.drawText(line, cx, height * 0.45f + bodySize * 1.5f, centerPaint)
            centerPaint.color = TEXT_DIM
            canvas.drawText("Tap to run again", cx, height * 0.58f, centerPaint)
        }
    }

    private companion object {
        // Speeds are authored against a 1080px-wide reference screen and scaled
        // by `sizeScale`, so the world crosses the display at the same rate
        // regardless of panel width.
        const val BASE_SPEED = 9f
        const val MAX_SPEED = 26f
        const val SPEED_PER_POINT = 0.011f
        const val POINTS_PER_LEVEL = 260f
        const val MIN_GAP_FRAMES = 74f
        const val MAX_GAP_FRAMES = 132f

        /** Floor on spawn spacing: below roughly this, a jump can't clear in time. */
        const val ABSOLUTE_MIN_GAP = 52f
        const val LEVEL_BANNER_FRAMES = 95f
        const val BIOME_FADE_FRAMES = 55f

        val BODY = 0xFFF1F5F9.toInt()

        /** Far leg, shaded down so the stride reads with depth. */
        val LEG_SHADE = 0xFFB8C2D0.toInt()
        val EYE = 0xFF0F172A.toInt()
        val TEXT = 0xFFF8FAFC.toInt()
        val TEXT_DIM = 0xFF94A3B8.toInt()
    }
}
