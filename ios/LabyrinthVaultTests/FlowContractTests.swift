//  FlowContractTests.swift
//  The route transition rules, held as properties rather than examples.
//
//  Vault.swift has claimed since its first commit that a refusal leads
//  nowhere but the scanner and that nothing signs without passing review.
//  These tests are that claim with a machine behind it. They iterate every
//  pair of route kinds, so a new case added to `RouteKind` is automatically
//  inside the net: forget to think about it and the exhaustive walks below
//  will say so.

import XCTest
// Two module names for one set of sources. Under `swift test` these files are
// the `LabyrinthVaultCore` SwiftPM target; under Xcode the same sources are
// compiled straight into the app, where the module is `LabyrinthVault`. Both
// runs matter and ios/README.md says why.
#if canImport(LabyrinthVaultCore)
@testable import LabyrinthVaultCore
#else
@testable import LabyrinthVault
#endif

final class FlowContractTests: XCTestCase {

    // MARK: - The signing path

    func testApproveIsReachableOnlyThroughReview() {
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .approve) {
            XCTAssertTrue(from == .review || from == .destination,
                          "approve reachable from \(from), which skips the screen that shows what is signed")
        }
    }

    func testSignedIsReachableOnlyThroughApprove() {
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .signed) {
            XCTAssertTrue(from == .approve || from == .signedQR,
                          "signed reachable from \(from) without the hold-to-sign")
        }
    }

    func testTheQRFaceBelongsToSigned() {
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .signedQR) {
            XCTAssertEqual(from, .signed, "signedQR reachable from \(from)")
        }
    }

    func testReviewComesFromTheReader() {
        let allowed: Set<RouteKind> = [.scanner, .acquiring, .received, .destination, .review]
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .review) {
            XCTAssertTrue(allowed.contains(from),
                          "review reachable from \(from), which never read a transaction")
        }
    }

    // MARK: - Refusals

    func testARefusalIsADeadEnd() {
        for to in RouteKind.allCases where Flow.allowed(from: .refused, to: to) {
            XCTAssertTrue(to == .scanner || to == .home,
                          "a refusal can escape to \(to); a refusal somebody can click through is no refusal")
        }
    }

    func testOnlyTheTransactionPathCanRefuse() {
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .refused) {
            XCTAssertFalse([RouteKind.home, .settings, .bitcoin, .monero, .recovery, .launch, .setup].contains(from),
                           "\(from) can refuse, and it has no transaction to refuse")
        }
    }

    // MARK: - The ordinary flow still works

    func testTheHappyPathIsWalkable() {
        let path: [RouteKind] = [.scanner, .acquiring, .received, .review, .destination,
                                 .review, .approve, .signed, .signedQR, .signed, .home]
        for (from, to) in zip(path, path.dropFirst()) {
            XCTAssertTrue(Flow.allowed(from: from, to: to), "\(from) -> \(to) should be allowed")
        }
    }

    func testTheRefusalPathIsWalkable() {
        XCTAssertTrue(Flow.allowed(from: .received, to: .refused))
        XCTAssertTrue(Flow.allowed(from: .refused, to: .scanner))
        XCTAssertTrue(Flow.allowed(from: .approve, to: .refused))
        XCTAssertTrue(Flow.allowed(from: .refused, to: .home))
    }

    func testKeyImagesComesFromTheReaderToo() {
        /* Same property as review, same reason: a screen full of key image
         * frames exists because a payload just finished assembling. */
        let allowed: Set<RouteKind> = [.scanner, .acquiring, .received]
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .keyImages) {
            XCTAssertTrue(allowed.contains(from),
                          "keyImages reachable from \(from), which never read a request")
        }
        XCTAssertTrue(Flow.allowed(from: .keyImages, to: .home))
        XCTAssertTrue(Flow.allowed(from: .keyImages, to: .scanner))
        XCTAssertFalse(Flow.allowed(from: .keyImages, to: .approve))
        XCTAssertFalse(Flow.allowed(from: .keyImages, to: .signed))
    }

    func testUnlockIsEnteredOnlyFromTheLaunchGate() {
        /* The other way in — the forced lock on backgrounding — bypasses the
         * table by design (see Flow.swift): a security preemption a table
         * could veto would be a screen where backgrounding leaves keys warm.
         * What the table holds is that no screen *navigates* to unlock: it is
         * an outcome of booting or of locking, never a destination. */
        for from in RouteKind.allCases where Flow.allowed(from: from, to: .unlock) {
            XCTAssertEqual(from, .launch, "unlock reachable by navigation from \(from)")
        }
        XCTAssertTrue(Flow.allowed(from: .unlock, to: .home), "a successful unlock must open the vault")
        XCTAssertFalse(Flow.allowed(from: .unlock, to: .approve))
        XCTAssertFalse(Flow.allowed(from: .unlock, to: .signed))
    }

    func testNothingReturnsToLaunch() {
        for from in RouteKind.allCases {
            XCTAssertFalse(Flow.allowed(from: from, to: .launch), "\(from) can reach the launch gate")
        }
    }

    func testChromeNavigationIsNotStrangled() {
        // The table is about the signing path; the rest of the app must move.
        XCTAssertTrue(Flow.allowed(from: .home, to: .settings))
        XCTAssertTrue(Flow.allowed(from: .settings, to: .home))
        XCTAssertTrue(Flow.allowed(from: .home, to: .scanner))
        XCTAssertTrue(Flow.allowed(from: .export, to: .home))
    }
}

final class IdentityTests: XCTestCase {
    func testGroupsTheKeyTailInFours() {
        XCTAssertEqual(Identity.vaultID(fromAccountKey: "zpubAAAABBBBCCCCDDDD"), "BBBB CCCC DDDD")
    }

    func testTwoDevicesHoldingTheSameKeyAgree() {
        let key = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"
        XCTAssertEqual(Identity.vaultID(fromAccountKey: key), Identity.vaultID(fromAccountKey: key))
        XCTAssertEqual(Identity.vaultID(fromAccountKey: key).count, 14) // 12 chars + 2 spaces
    }

    func testShortInputDoesNotCrashTheFormatter() {
        XCTAssertEqual(Identity.vaultID(fromAccountKey: "abc"), "ABC")
        XCTAssertEqual(Identity.vaultID(fromAccountKey: ""), "•••• •••• ••••")
    }

    func testFingerprintIsTheAddressTail() {
        XCTAssertEqual(Identity.fingerprint(fromFirstAddress: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"), "8Z306FYU")
        XCTAssertEqual(Identity.fingerprint(fromFirstAddress: ""), "········")
    }
}
