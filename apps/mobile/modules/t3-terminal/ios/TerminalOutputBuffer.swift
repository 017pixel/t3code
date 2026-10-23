import Foundation

// Keep only replay history for intentional surface recreation (font/theme changes).
final class TerminalOutputBuffer {
  private(set) var data = Data()
  private let limit = 512 * 1024

  func write(_ text: String, reset: Bool) {
    if reset {
      data = Data(text.utf8)
    } else {
      data.append(contentsOf: text.utf8)
    }
    guard data.count > limit else { return }
    var start = data.count - limit
    while start < data.count && data[data.startIndex + start] & 0xC0 == 0x80 {
      start += 1
    }
    data = Data(data.dropFirst(start))
  }
}
