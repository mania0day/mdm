package com.sentroid.agent.game

import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.sentroid.agent.data.ApiClient
import com.sentroid.agent.data.Prefs

/**
 * Hosts the runner mini-game full-screen. Built entirely in code (no layout
 * XML) since it's just the game view plus a close affordance — not worth a
 * resource file for two elements.
 */
class GameActivity : AppCompatActivity() {

    private lateinit var prefs: Prefs
    private lateinit var gameView: DinoGameView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)

        // Immersive: the game draws its own sky edge to edge, and the system
        // bars would otherwise sit on top of the HUD.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        val root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#0B1026")) }

        gameView = DinoGameView(this).apply { bestScore = prefs.localHighScore }
        root.addView(
            gameView,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )

        val closeBtn = TextView(this).apply {
            text = "✕"
            setTextColor(Color.parseColor("#94A3B8"))
            textSize = 18f
            val pad = (18 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad, pad, pad)
            setOnClickListener { finish() }
        }
        root.addView(
            closeBtn,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.END,
            ),
        )

        setContentView(root)

        gameView.onGameOver = { score ->
            if (score > prefs.localHighScore) {
                prefs.localHighScore = score
                gameView.bestScore = score
            }
            submitScore(score)
        }

        gameView.onLevelUp = {
            gameView.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        }
    }

    private fun submitScore(score: Int) {
        val server = prefs.serverUrl
        val token = prefs.deviceToken
        if (server.isBlank() || token.isNullOrBlank()) return
        Thread {
            try {
                ApiClient(server, token).submitGameScore(score)
            } catch (e: Exception) {
                // Best-effort — the local high score already updated above and a
                // later, higher score will sync next time regardless.
            }
        }.start()
    }
}
