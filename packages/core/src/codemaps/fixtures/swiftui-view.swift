import SwiftUI

@Observable
final class CounterModel {
    var total: Int = 0
}

struct CounterView: View {
    @State private var count: Int = 0
    @Binding var title: String
    @Environment(\.colorScheme) private var colorScheme
    @StateObject private var store = Store()
    @ObservedObject var legacy: LegacyStore
    @Published var isReady: Bool = false

    var body: some View {
        Text("\(title): \(count)")
    }

    func increment() {
        count += 1
    }
}

#Preview {
    CounterView(title: .constant("Preview"), legacy: LegacyStore())
}

#Preview("Dark") {
    CounterView(title: .constant("Dark"), legacy: LegacyStore())
}
