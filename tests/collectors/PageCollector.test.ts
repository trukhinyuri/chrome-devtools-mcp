/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, beforeEach, describe, it} from 'node:test';

import type {
  CDPSession,
  ConsoleMessage,
  Frame,
  HTTPRequest,
  Protocol,
} from 'puppeteer-core';
import sinon from 'sinon';

import type {ListenerMap} from '../../src/collectors/PageCollector.js';
import {
  BufferedConsoleMessage,
  ConsoleCollector,
  NetworkCollector,
  PageCollector,
  UncaughtError,
} from '../../src/collectors/PageCollector.js';
import {DevTools, FrameEvent} from '../../src/third_party/index.js';

import {mockListener} from '../mocks.js';
import {getMockRequest, getMockBrowser} from '../utils.js';

function createMockConsoleMessage(text: string): ConsoleMessage {
  return {
    type: () => 'log',
    text: () => text,
    args: () => [],
  } as unknown as ConsoleMessage;
}

function getMockCdpSessionWithReplay(
  replayed: Array<
    | ['Runtime.consoleAPICalled', Protocol.Runtime.ConsoleAPICalledEvent]
    | ['Runtime.exceptionThrown', Protocol.Runtime.ExceptionThrownEvent]
    | ['Log.entryAdded', Protocol.Log.EntryAddedEvent]
  >,
): CDPSession {
  const session = {
    ...mockListener(),
    async send(method: string) {
      if (method === 'Target.getTargetInfo') {
        return {targetInfo: {targetId: '<mock target ID>'}};
      }
      // Chromium replays buffered events before the enable call resolves.
      const domain = method.split('.')[0];
      for (const [eventName, event] of replayed) {
        if (method.endsWith('.enable') && eventName.startsWith(domain)) {
          session.emit(eventName, event);
        }
      }
      return undefined;
    },
    async detach() {
      // no-op
    },
  };
  return session as unknown as CDPSession;
}

describe('PageCollector', () => {
  it('works', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const request = getMockRequest();
    const collector = new PageCollector(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request);

    assert.equal(collector.getData()[0], request);
  });

  it('clean up after navigation', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const request = getMockRequest();
    const collector = new PageCollector(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request);

    assert.equal(collector.getData()[0], request);
    page.emit('framenavigated', mainFrame);

    assert.equal(collector.getData().length, 0);
  });

  it('does not clean up after same-document navigation', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const request = getMockRequest();
    const collector = new PageCollector(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request);

    assert.equal(collector.getData()[0], request);

    // Simulate a same-document (SPA) navigation: Puppeteer emits
    // `FrameNavigatedWithinDocument` right before `framenavigated`.
    mainFrame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
    page.emit('framenavigated', mainFrame);

    assert.equal(collector.getData()[0], request);
  });

  it('cleans up after a cross-document navigation following a same-document one', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const request = getMockRequest();
    const collector = new PageCollector(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request);

    // Same-document navigation: history is kept.
    mainFrame.emit(FrameEvent.FrameNavigatedWithinDocument, undefined);
    page.emit('framenavigated', mainFrame);
    assert.equal(collector.getData()[0], request);

    // A real cross-document navigation must still rotate the history.
    page.emit('framenavigated', mainFrame);
    assert.equal(collector.getData().length, 0);
  });

  it('does not clean up after sub frame navigation', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const request = getMockRequest();
    const collector = new PageCollector(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request);
    page.emit('framenavigated', {} as Frame);

    assert.equal(collector.getData().length, 1);
  });

  it('clean up after navigation and be able to add data after', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const request = getMockRequest();
    const collector = new PageCollector(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request);

    assert.equal(collector.getData()[0], request);
    page.emit('framenavigated', mainFrame);

    assert.equal(collector.getData().length, 0);

    page.emit('request', request);

    assert.equal(collector.getData().length, 1);
  });

  it('should assign ids to requests', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const request1 = getMockRequest();
    const request2 = getMockRequest();
    const collector = new PageCollector<HTTPRequest>(page, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });

    page.emit('request', request1);
    page.emit('request', request2);

    assert.equal(collector.getData().length, 2);

    assert.equal(collector.getIdForResource(request1), 1);
    assert.equal(collector.getIdForResource(request2), 2);
  });
});

describe('NetworkCollector', () => {
  it('retains only the newest requests without navigation', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const collector = new NetworkCollector(page);
    const requests = Array.from(
      {
        length: NetworkCollector.MAX_REQUESTS_PER_NAVIGATION + 1,
      },
      (_, index) =>
        getMockRequest({url: `http://example.com/request-${index + 1}`}),
    );

    for (const request of requests) {
      page.emit('request', request);
    }

    const retainedRequests = collector.getData();
    assert.equal(
      retainedRequests.length,
      NetworkCollector.MAX_REQUESTS_PER_NAVIGATION,
    );
    assert.deepEqual(retainedRequests, requests.slice(1));
    assert.equal(collector.getIdForResource(retainedRequests[0]), 2);
    assert.equal(collector.getById(2), retainedRequests[0]);
    assert.throws(() => collector.getById(1), {
      message: 'Request not found for selected page',
    });
  });

  it('correctly picks up navigation requests to latest navigation', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const request = getMockRequest();
    const navRequest = getMockRequest({
      navigationRequest: true,
      frame: page.mainFrame(),
    });
    const request2 = getMockRequest();
    const collector = new NetworkCollector(page);

    page.emit('request', request);
    page.emit('request', navRequest);

    assert.equal(collector.getData()[0], request);
    assert.equal(collector.getData()[1], navRequest);
    page.emit('framenavigated', mainFrame);

    assert.equal(collector.getData().length, 1);
    assert.equal(collector.getData()[0], navRequest);

    page.emit('request', request2);

    assert.equal(collector.getData().length, 2);
    assert.equal(collector.getData()[0], navRequest);
    assert.equal(collector.getData()[1], request2);
  });

  it('correctly picks up after multiple back to back navigations', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const navRequest = getMockRequest({
      navigationRequest: true,
      frame: page.mainFrame(),
    });
    const navRequest2 = getMockRequest({
      navigationRequest: true,
      frame: page.mainFrame(),
    });
    const request = getMockRequest();

    const collector = new NetworkCollector(page);

    page.emit('request', navRequest);
    assert.equal(collector.getData()[0], navRequest);

    page.emit('framenavigated', mainFrame);
    assert.equal(collector.getData().length, 1);
    assert.equal(collector.getData()[0], navRequest);

    page.emit('request', navRequest2);
    assert.equal(collector.getData().length, 2);
    assert.equal(collector.getData()[0], navRequest);
    assert.equal(collector.getData()[1], navRequest2);

    page.emit('framenavigated', mainFrame);
    assert.equal(collector.getData().length, 1);
    assert.equal(collector.getData()[0], navRequest2);

    page.emit('request', request);
    assert.equal(collector.getData().length, 2);
  });

  it('works with previous navigations', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const navRequest = getMockRequest({
      navigationRequest: true,
      frame: page.mainFrame(),
    });
    const navRequest2 = getMockRequest({
      navigationRequest: true,
      frame: page.mainFrame(),
    });
    const request = getMockRequest();

    const collector = new NetworkCollector(page);

    page.emit('request', navRequest);
    assert.equal(collector.getData(true).length, 1);

    page.emit('framenavigated', mainFrame);
    assert.equal(collector.getData(true).length, 1);

    page.emit('request', navRequest2);
    assert.equal(collector.getData(true).length, 2);

    page.emit('framenavigated', mainFrame);
    assert.equal(collector.getData(true).length, 2);

    page.emit('request', request);
    assert.equal(collector.getData(true).length, 3);
  });

  it('should not grow beyond maxNavigationSaved', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const collector = new NetworkCollector(page);

    // Simulate 5 navigations (maxNavigationSaved is 3)
    for (let i = 0; i < 5; i++) {
      const req = getMockRequest({
        url: `http://example.com/nav${i}`,
        navigationRequest: true,
        frame: mainFrame,
      });
      page.emit('request', req);
      page.emit('framenavigated', mainFrame);
    }

    // We expect 3 arrays in navigations (current + 2 saved)
    // Each navigation has 1 request, so total should be 3
    assert.equal(collector.getData(true).length, 3);
  });

  it('bounds retained navigation buckets with redirects and subframes', async () => {
    class TestNetworkCollector extends NetworkCollector {
      get navigationSizes(): number[] {
        return this.storage.map(requests => requests.length);
      }
    }

    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const collector = new TestNetworkCollector(page, 3);

    const firstNavigation = getMockRequest({
      url: 'http://example.com/first',
      navigationRequest: true,
      frame: mainFrame,
    });
    const firstResource = getMockRequest({
      url: 'http://example.com/first-resource',
    });
    const subframeResource = getMockRequest({
      url: 'http://example.com/subframe-resource',
    });
    page.emit('request', firstNavigation);
    page.emit('framenavigated', mainFrame);
    page.emit('request', firstResource);
    page.emit('framenavigated', {} as Frame);
    page.emit('request', subframeResource);

    const redirectNavigation = getMockRequest({
      url: 'http://example.com/redirect',
      navigationRequest: true,
      frame: mainFrame,
    });
    const redirectedNavigation = getMockRequest({
      url: 'http://example.com/redirected',
      navigationRequest: true,
      frame: mainFrame,
    });
    const redirectedResource = getMockRequest({
      url: 'http://example.com/redirected-resource',
    });
    page.emit('request', redirectNavigation);
    page.emit('request', redirectedNavigation);
    page.emit('framenavigated', mainFrame);
    page.emit('request', redirectedResource);

    const finalNavigation = getMockRequest({
      url: 'http://example.com/final',
      navigationRequest: true,
      frame: mainFrame,
    });
    const finalResource1 = getMockRequest({
      url: 'http://example.com/final-resource-1',
    });
    const finalResource2 = getMockRequest({
      url: 'http://example.com/final-resource-2',
    });
    page.emit('request', finalNavigation);
    page.emit('framenavigated', mainFrame);
    page.emit('request', finalResource1);
    page.emit('request', finalResource2);

    assert.deepEqual(collector.getData(true), [
      subframeResource,
      redirectNavigation,
      redirectedNavigation,
      redirectedResource,
      finalNavigation,
      finalResource1,
      finalResource2,
    ]);
    assert.equal(collector.getData().length, 3);
    assert.equal(collector.getData()[0], finalNavigation);
    assert.deepEqual(collector.navigationSizes, [3, 2, 2]);
  });
});

describe('ConsoleCollector', () => {
  let issue: Protocol.Audits.InspectorIssue;

  beforeEach(() => {
    issue = {
      code: 'MixedContentIssue',
      details: {
        mixedContentIssueDetails: {
          insecureURL: 'test.url',
          resolutionStatus: 'MixedContentBlocked',
          mainResourceURL: '',
        },
      },
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  it('collects issues', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const collector = new ConsoleCollector(page, collect => {
      return {
        devtoolsAggregatedIssue: issue => {
          collect(issue);
        },
      } as ListenerMap;
    });

    const issue2 = {
      code: 'ElementAccessibilityIssue' as const,
      details: {
        elementAccessibilityIssueDetails: {
          nodeId: 1,
          elementAccessibilityIssueReason: 'DisallowedSelectChild',
          hasDisallowedAttributes: true,
        },
      },
    } satisfies Protocol.Audits.InspectorIssue;

    page.emit('issue', issue);
    page.emit('issue', issue2);
    const data = collector.getData();
    assert.equal(data.length, 2);
  });

  it('silently ignores unmapped PerformanceIssue events', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const warnStub = sinon.stub(console, 'warn');

    const collector = new ConsoleCollector(page, collect => {
      return {
        devtoolsAggregatedIssue: issue => {
          collect(issue);
        },
      } as ListenerMap;
    });

    const performanceIssue = {
      code: 'PerformanceIssue',
      details: {
        performanceIssueDetails: {
          performanceIssueType: 'DocumentCookie',
        },
      },
    } as unknown as Protocol.Audits.InspectorIssue;

    page.emit('issue', performanceIssue);

    assert.equal(collector.getData().length, 0);
    sinon.assert.notCalled(warnStub);
  });

  it('filters duplicated issues', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];

    const collector = new ConsoleCollector(page, collect => {
      return {
        devtoolsAggregatedIssue: issue => {
          collect(issue);
        },
      } as ListenerMap;
    });

    page.emit('issue', issue);
    page.emit('issue', issue);
    const data = collector.getData();
    assert.equal(data.length, 1);
    const collectedIssue = data[0];
    assert(collectedIssue instanceof DevTools.AggregatedIssue);
    assert.equal(collectedIssue.code(), 'MixedContentIssue');
    assert.equal(collectedIssue.getAggregatedIssuesCount(), 1);
  });

  it('emits UncaughtErrors for Runtime.exceptionThrown CDP events', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    // @ts-expect-error internal API.
    const cdpSession = page._client();
    const onUncaughtErrorListener = sinon.spy();
    new ConsoleCollector(page, () => {
      return {
        uncaughtError: onUncaughtErrorListener,
      } as ListenerMap;
    });

    cdpSession.emit('Runtime.exceptionThrown', {
      exceptionDetails: {
        exception: {description: 'SyntaxError: Expected {'},
        text: 'Uncaught',
        stackTrace: {callFrames: []},
      },
    });

    sinon.assert.calledOnceWithMatch(
      onUncaughtErrorListener,
      sinon.match(e => {
        return (
          e.details.exception.description === 'SyntaxError: Expected {',
          e.details.text === 'Uncaught',
          e.details.stackTrace.callFrames.length === 0
        );
      }),
    );
  });

  it('retains only the newest messages per navigation', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const cap = 5;
    const collector = new ConsoleCollector(
      page,
      collect => {
        return {
          console: (msg: ConsoleMessage) => {
            collect(msg);
          },
        } as ListenerMap;
      },
      cap,
    );

    const messages = Array.from({length: cap + 3}, (_, i) =>
      createMockConsoleMessage(`msg-${i}`),
    );

    for (const msg of messages) {
      page.emit('console', msg);
    }

    const retained = collector.getData();
    assert.equal(retained.length, cap);
    assert.deepEqual(retained, messages.slice(messages.length - cap));
  });

  it('uses MAX_MESSAGES_PER_NAVIGATION as the default cap', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const collector = new ConsoleCollector(page, collect => {
      return {
        console: (msg: ConsoleMessage) => {
          collect(msg);
        },
      } as ListenerMap;
    });

    const messages = Array.from(
      {length: ConsoleCollector.MAX_MESSAGES_PER_NAVIGATION + 1},
      (_, i) => createMockConsoleMessage(`msg-${i}`),
    );

    for (const msg of messages) {
      page.emit('console', msg);
    }

    assert.equal(
      collector.getData().length,
      ConsoleCollector.MAX_MESSAGES_PER_NAVIGATION,
    );
  });

  it('backfills messages buffered before construction', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    page.createCDPSession = async () =>
      getMockCdpSessionWithReplay([
        [
          'Runtime.consoleAPICalled',
          {
            type: 'warning',
            args: [
              {type: 'string', value: 'buffered'},
              {type: 'number', value: 42},
            ],
            executionContextId: 1,
            timestamp: Date.now() - 2000,
          },
        ],
        [
          'Runtime.exceptionThrown',
          {
            timestamp: Date.now() - 1000,
            exceptionDetails: {
              exceptionId: 1,
              text: 'Uncaught',
              lineNumber: 0,
              columnNumber: 0,
            },
          },
        ],
        [
          'Log.entryAdded',
          {
            entry: {
              source: 'network',
              level: 'error',
              text: 'Failed to load resource: net::ERR_CONNECTION_REFUSED',
              // The oldest event, though replayed last (the Log domain is
              // enabled after Runtime) - the merge must order it first.
              timestamp: Date.now() - 3000,
            },
          },
        ],
        [
          'Log.entryAdded',
          {
            entry: {
              source: 'worker',
              level: 'verbose',
              text: 'skipped like in live collection',
              timestamp: Date.now() - 3000,
            },
          },
        ],
      ]);

    const collector = new ConsoleCollector(page, collect => {
      return {
        console: message => {
          collect(message);
        },
        uncaughtError: error => {
          collect(error);
        },
      } as ListenerMap;
    });
    await collector.backfilled;

    const data = collector.getData();
    assert.equal(data.length, 3);
    const logEntry = data[0];
    assert.ok(logEntry instanceof BufferedConsoleMessage);
    assert.equal(logEntry.type(), 'error');
    assert.ok(logEntry.text().startsWith('Failed to load resource'));
    const message = data[1];
    assert.ok(message instanceof BufferedConsoleMessage);
    assert.equal(message.type(), 'warn');
    assert.equal(message.text(), 'buffered 42');
    assert.equal(message.argsCount, 2);
    assert.ok(data[2] instanceof UncaughtError);
  });

  it('prepends backfilled messages and drops post-attach replays', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    page.createCDPSession = async () =>
      getMockCdpSessionWithReplay([
        [
          'Runtime.consoleAPICalled',
          {
            type: 'log',
            args: [{type: 'string', value: 'buffered'}],
            executionContextId: 1,
            timestamp: Date.now() - 1000,
          },
        ],
        [
          'Runtime.consoleAPICalled',
          {
            type: 'log',
            // Live collection already has anything logged after attach time,
            // so this replayed event must be dropped.
            args: [{type: 'string', value: 'already collected live'}],
            executionContextId: 1,
            timestamp: Date.now() + 60_000,
          },
        ],
      ]);

    const collector = new ConsoleCollector(page, collect => {
      return {
        console: message => {
          collect(message);
        },
      } as ListenerMap;
    });
    const liveMessage = {} as ConsoleMessage;
    page.emit('console', liveMessage);
    await collector.backfilled;

    const data = collector.getData();
    assert.equal(data.length, 2);
    const backfilled = data[0];
    assert.ok(backfilled instanceof BufferedConsoleMessage);
    assert.equal(backfilled.text(), 'buffered');
    assert.equal(data[1], liveMessage);
  });

  it('keeps backfilled messages out of newer navigations', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    mainFrame.page = () => page;
    const {promise: sessionPromise, resolve: resolveSession} =
      Promise.withResolvers<CDPSession>();
    page.createCDPSession = () => sessionPromise;

    const collector = new ConsoleCollector(page, collect => {
      return {
        console: message => {
          collect(message);
        },
      } as ListenerMap;
    });
    // The page navigates before the backfill session is ready, so the
    // recovered message belongs to the previous navigation's bucket.
    page.emit('framenavigated', page.mainFrame());
    resolveSession(
      getMockCdpSessionWithReplay([
        [
          'Runtime.consoleAPICalled',
          {
            type: 'log',
            args: [{type: 'string', value: 'buffered'}],
            executionContextId: 1,
            timestamp: Date.now() - 1000,
          },
        ],
      ]),
    );
    await collector.backfilled;

    assert.equal(collector.getData().length, 0);
    assert.equal(collector.getData(true).length, 1);
  });
});
