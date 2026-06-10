// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CounterKit",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "CounterKit", targets: ["CounterKit"]),
        .executable(name: "CounterTool", targets: ["CounterTool"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.5.0"),
    ],
    targets: [
        .target(name: "CounterKit", dependencies: []),
        .executableTarget(name: "CounterTool", dependencies: ["CounterKit"]),
        .testTarget(name: "CounterKitTests", dependencies: ["CounterKit"]),
    ]
)
