import Foundation
import Testing
@testable import T3Code

@Suite("Agent thread links")
struct PlatformAgentThreadLinkTests {
    @Test
    func escapedIDsAreDecodedOnceWithoutChangingIdentity() throws {
        for (link, environment, thread) in [
            ("t3-thread://v1/remote%2Fone/task%20%281%29", "remote/one", "task (1)"),
            ("t3-thread://v1/%20env%20/thread%252F1", " env ", "thread%2F1"),
            ("t3-thread://v1/env%23one/thread%3Ftwo%25", "env#one", "thread?two%"),
            ("t3-thread://v1/env/%E6%97%A5%E6%9C%AC", "env", "日本"),
        ] {
            let expected = PlatformRoute.thread(environmentID: environment, threadID: thread)
            #expect(try PlatformDeepLinkParser.parse(link) == expected)
            let url = try #require(URL(string: link))
            #expect(PlatformDeepLinkParser.isThreadLink(url))
            #expect(try PlatformDeepLinkParser.parse(url) == expected)
        }
    }

    @Test
    func rejectsMalformedEscapesBeforeFoundationRepairsThem() {
        for suffix in ["env/thread%", "env/thread%2", "env/thread%ZZ", "env/%FF", "env/%C0%AF", "%Q0/thread"] {
            #expect(throws: PlatformDeepLinkError.invalidIdentifier) {
                try PlatformDeepLinkParser.parse("t3-thread://v1/\(suffix)")
            }
        }
    }

    @Test
    func requiresExactlyTwoNonemptySegmentsAndTheSupportedVersion() {
        for link in [
            "t3-thread://v1/env", "t3-thread://v1/env/thread/extra",
            "t3-thread://v1/env/thread/", "t3-thread://v1//thread",
            "t3-thread://v1/env/", "t3-thread://v1///",
            "t3-thread://v2/env/thread", "t3-thread://v1:80/env/thread",
            "t3-thread://user@v1/env/thread", "t3-thread:///v1/env/thread",
            "t3-thread://v1/env/thread?environment=other", "t3-thread://v1/env/thread#extra",
            "t3-thread://v1/env/thread%00",
        ] {
            #expect(throws: (any Error).self) { try PlatformDeepLinkParser.parse(link) }
        }
    }

    @Test
    func invalidOrUnloadedInternalLinksAreStillOwnedByTheApp() throws {
        for link in ["t3-thread://v2/env/thread", "t3-thread://v1/missing/archived"] {
            #expect(PlatformDeepLinkParser.isThreadLink(try #require(URL(string: link))))
        }
        #expect(!PlatformDeepLinkParser.isThreadLink(try #require(URL(string: "https://example.com"))))
    }

    @Test
    func crossEnvironmentLinkResolvesTheSpecifiedWireID() throws {
        let first = FeatureThread(id: "first-scoped", wireID: "same", projectID: "project", environmentID: "first", title: "First")
        let second = FeatureThread(id: "second-scoped", wireID: "same", projectID: "project", environmentID: "second", title: "Second")
        let snapshot = FeatureSnapshot(threads: [first, second])
        let route = try PlatformDeepLinkParser.parse("t3-thread://v1/second/same")
        guard case let .thread(environmentID, threadID) = route else {
            Issue.record("Expected an environment-scoped thread route")
            return
        }
        #expect(PlatformRouteResolver.thread(in: snapshot, environmentID: environmentID, id: threadID)?.id == second.id)
        #expect(PlatformRouteResolver.thread(in: snapshot, environmentID: "missing", id: threadID) == nil)
    }
}
