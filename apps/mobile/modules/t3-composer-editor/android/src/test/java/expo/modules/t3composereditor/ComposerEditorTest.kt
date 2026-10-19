package expo.modules.t3composereditor

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], manifest = Config.NONE)
class ComposerEditorTest {
  private val context = RuntimeEnvironment.getApplication()
  private val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  private val editor = SelectionAwareEditText(context).apply {
    textPasteThresholdBytes = 32 * 1024
    maxInputChars = 120_000
  }

  private fun pasteAsText(): Boolean = editor.onKeyShortcut(
    KeyEvent.KEYCODE_V,
    KeyEvent(
      0,
      0,
      KeyEvent.ACTION_DOWN,
      KeyEvent.KEYCODE_V,
      0,
      KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON
    )
  )

  @Test
  fun shortcutKeepsLargeTextInlineAndUndoable() {
    val pasted = "x".repeat(32 * 1024)
    clipboard.setPrimaryClip(ClipData.newPlainText("test", pasted))
    editor.setText("before old after")
    editor.setSelection(10, 7)
    editor.pasteTextListener = { _, _, _ -> error("Inline paste must stay native") }

    assertTrue(pasteAsText())
    assertEquals("before $pasted after", editor.text.toString())
    assertTrue(editor.onTextContextMenuItem(android.R.id.undo))
    assertEquals("before old after", editor.text.toString())
  }

  @Test
  fun shortcutInterceptsInputLimitOverflowWithoutChangingTheSelection() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "hello"))
    editor.setText("x".repeat(119_999))
    editor.setSelection(10, 7)
    var intercepted: Triple<String, Int, Int>? = null
    editor.pasteTextListener = { text, start, end -> intercepted = Triple(text, start, end) }

    assertTrue(pasteAsText())
    assertEquals(Triple("hello", 7, 10), intercepted)
    assertEquals(119_999, editor.length())
    assertEquals(10, editor.selectionStart)
    assertEquals(7, editor.selectionEnd)
  }

  @Test
  fun shortcutAllowsReplacementAtTheInputLimit() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "hello"))
    editor.setText("x".repeat(120_000))
    editor.setSelection(12, 7)
    editor.pasteTextListener = { _, _, _ -> error("Replacement fits the input limit") }

    assertTrue(pasteAsText())
    assertEquals("hello", editor.text.substring(7, 12))
    assertEquals(120_000, editor.length())
  }

  @Test
  fun regularPasteStillFoldsAtTheUtf8Threshold() {
    val pasted = "é".repeat(16 * 1024)
    clipboard.setPrimaryClip(ClipData.newPlainText("test", pasted))
    editor.setText("old")
    editor.setSelection(0, 3)
    var intercepted: String? = null
    editor.pasteTextListener = { text, _, _ -> intercepted = text }

    assertTrue(editor.onTextContextMenuItem(android.R.id.paste))
    assertEquals(pasted, intercepted)
    assertEquals("old", editor.text.toString())
  }

  @Test
  fun shortcutPastesStructuredClipboardAsText() {
    clipboard.setPrimaryClip(
      ClipData.newHtmlText(
        "test",
        "plain text",
        "<pre data-t3-context-fragment=\"x\">plain text</pre>"
      )
    )
    editor.setSelection(0)
    editor.pasteContextListener = { error("Paste as Text must not import structured context") }

    assertTrue(pasteAsText())
    assertEquals("plain text", editor.text.toString())
  }

  @Test
  fun readOnlyShortcutDoesNotPasteOrEmitAnEvent() {
    clipboard.setPrimaryClip(ClipData.newPlainText("test", "x".repeat(120_001)))
    editor.setText("unchanged")
    editor.setSelection(editor.length())
    editor.readOnly = true
    var intercepted: String? = null
    editor.pasteTextListener = { text, _, _ -> intercepted = text }

    assertFalse(pasteAsText())
    assertEquals("unchanged", editor.text.toString())
    assertNull(intercepted)
  }

  private fun submissionEditor(sends: MutableList<Boolean>) = SelectionAwareEditText(context).apply {
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
    setText("draft")
    setSelection(length())
    submitEnabled = true
    submitListener = { sends += it }
  }

  private fun SelectionAwareEditText.pressReturn(
    modifiers: Int = 0,
    repeats: Int = 0,
    deviceId: Int = 1,
    flags: Int = 0,
  ) {
    val down = KeyEvent(
      0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER,
      0, modifiers, deviceId, 0, flags,
    )
    dispatchKeyEvent(down)
    repeat(repeats) { dispatchKeyEvent(KeyEvent.changeTimeRepeat(down, 0, it + 1)) }
    dispatchKeyEvent(KeyEvent.changeAction(down, KeyEvent.ACTION_UP))
  }

  @Test
  fun hardwareReturnSendsOnceWithAnAlternateAndANewlineChord() {
    val sends = mutableListOf<Boolean>()
    val editor = submissionEditor(sends)

    editor.pressReturn(repeats = 2)
    editor.pressReturn(KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON)
    editor.pressReturn(KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON)

    assertEquals(listOf(false, true), sends)
    assertEquals("draft\n", editor.text.toString())
  }

  @Test
  fun hardwareReturnWaitsUntilCompositionEndsToSubmit() {
    val sends = mutableListOf<Boolean>()
    val editor = submissionEditor(sends)
    BaseInputConnection.setComposingSpans(editor.text)
    assertTrue(BaseInputConnection.getComposingSpanStart(editor.text) >= 0)

    editor.pressReturn()
    assertEquals(emptyList<Boolean>(), sends)

    BaseInputConnection.removeComposingSpans(editor.text)
    assertEquals(-1, BaseInputConnection.getComposingSpanStart(editor.text))

    editor.pressReturn()
    assertEquals(listOf(false), sends)
  }

  @Test
  fun newlineSettingKeepsReturnForEditingAndCtrlForSubmission() {
    val sends = mutableListOf<Boolean>()
    val editor = submissionEditor(sends).apply { returnSends = false }

    editor.pressReturn()
    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("draft\n", editor.text.toString())

    editor.pressReturn(KeyEvent.META_CTRL_ON)
    editor.pressReturn(KeyEvent.META_CTRL_ON or KeyEvent.META_SHIFT_ON)
    assertEquals(listOf(false, true), sends)
    assertEquals("draft\n", editor.text.toString())
  }

  @Test
  fun softKeyboardReturnStillEditsWhenHardwareReturnSends() {
    val sends = mutableListOf<Boolean>()
    val editor = submissionEditor(sends)

    editor.pressReturn(deviceId = KeyCharacterMap.VIRTUAL_KEYBOARD)
    editor.pressReturn(flags = KeyEvent.FLAG_SOFT_KEYBOARD)

    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("draft\n\n", editor.text.toString())
  }

  @Test
  fun unavailableSubmissionFallsThroughToEditing() {
    val sends = mutableListOf<Boolean>()
    val editor = submissionEditor(sends).apply { submitEnabled = false }

    editor.pressReturn()
    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("draft\n", editor.text.toString())

    editor.submitEnabled = true
    editor.submitListener = null
    editor.pressReturn()
    assertEquals(emptyList<Boolean>(), sends)
    assertEquals("draft\n\n", editor.text.toString())

    editor.submitListener = { sends += it }
    editor.readOnly = true
    editor.pressReturn()
    assertEquals(emptyList<Boolean>(), sends)
  }
}
