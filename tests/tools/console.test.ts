/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import path from 'node:path';
import {before, describe, it} from 'node:test';

import type {Dialog} from 'puppeteer-core';

import type {ParsedArguments} from '../../src/config/ConfigParser.js';
import {loadIssueDescriptions} from '../../src/devtools/issueDescriptions.js';
import {McpResponse} from '../../src/McpResponse.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';
import type {CdpWebWorker} from '../../src/third_party/index.js';
import {DevTools} from '../../src/third_party/index.js';
import {
  getConsoleMessage,
  listConsoleMessages,
} from '../../src/tools/console.js';
import {installExtension} from '../../src/tools/extensions.js';
import {serverHooks} from '../server.js';
import {
  getTextContent,
  withMcpContext,
  stabilizeStructuredContent,
  extractExtensionId,
  assertNoServiceWorkerReported,
  waitExecutionFor,
  stabilizeResponseOutput,
} from '../utils.js';

const EXTENSION_LOGGING_PATH = path.join(
  import.meta.dirname,
  '../../../tests/tools/fixtures/extension-logging',
);

describe('console', () => {
  before(async () => {
    await loadIssueDescriptions();
  });

  it('captures logs and errors from extension service worker', async t => {
    await withMcpContext(
      async (response, context, args) => {
        await installExtension(args).handler(
          {params: {path: EXTENSION_LOGGING_PATH}},
          response,
          context,
        );

        const extensionId = extractExtensionId(response);
        assert.ok(extensionId, 'Extension ID should be returned');

        const swTarget = await context.browser.waitForTarget(
          t => t.type() === 'service_worker' && t.url().includes(extensionId),
        );

        const swList = context.createWorkersSnapshot();
        const sw = swList.find(s => s.target === swTarget);
        assert(sw, 'Service worker not found in context list');

        const response2 = new McpResponse(args);

        await context.triggerExtensionAction(extensionId);
        const worker = await swTarget.worker();

        const timeout = 10000;
        await waitExecutionFor(async () => {
          await worker?.evaluate(() => {
            if (typeof globalThis.setTimeout !== 'function') {
              throw new Error('Not ready');
            }
          });
        }, timeout);

        const errorPromise = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Timeout waiting for Service Worker error'));
          }, 5000);
          (worker as unknown as CdpWebWorker).client.on(
            'Runtime.exceptionThrown',
            () => {
              clearTimeout(timeout);
              resolve(undefined);
            },
          );
        });

        worker?.evaluate(() => {
          globalThis.setTimeout(() => {
            throw new Error('Intentional error from Service Worker');
          }, 100);
        });

        await errorPromise;
        response2.resetResponseLineForTesting();

        await listConsoleMessages(args).handler(
          {
            params: {serviceWorkerId: extensionId},
            page: context.getSelectedMcpPage(),
          },
          response2,
          context,
        );

        const formattedResponse = await response2.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);

        const sanitizedText = textContent.replaceAll(
          new RegExp(extensionId, 'g'),
          '<extension-id>',
        );

        t.assert.snapshot?.(sanitizedText);

        assert.ok(
          sanitizedText.includes('Service Worker starting...'),
          'Should contain start log',
        );
        assert.ok(
          sanitizedText.includes('This is a warning from Service Worker'),
          'Should contain warning log',
        );
        assert.ok(
          sanitizedText.includes('Intentional error from Service Worker'),
          'Should contain error log',
        );

        await context.uninstallExtension(extensionId);
        const targets = context.browser.targets();
        assertNoServiceWorkerReported(targets, extensionId);
      },
      {},
      {
        categoryExtensions: true,
      } as ParsedArguments,
    );
  });

  describe('list_console_messages', () => {
    it('list messages', async () => {
      await withMcpContext(async (response, context, args) => {
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.ok(response.includeConsoleData);
      });
    });

    it('lists error messages', async () => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent(
          '<script>console.error("This is an error")</script>',
        );
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);
        assert.ok(textContent.includes('msgid=1 [error] This is an error'));
      });
    });

    it('lists error objects', async t => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent(
          '<script>console.error(new Error("This is an error"))</script>',
        );
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);
        t.assert.snapshot(textContent);
      });
    });

    it('includes stack traces when includeStackTraces is set', async () => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent(
          '<script>function failingFn() { console.error("This is an error"); } failingFn();</script>',
        );
        await listConsoleMessages(args).handler(
          {
            params: {includeStackTraces: true},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);
        assert.ok(textContent.includes('msgid=1 [error] This is an error'));
        assert.match(textContent, /at failingFn/);
        const structuredContent = formattedResponse.structuredContent as {
          consoleMessages: Array<{stackTrace?: string}>;
        };
        assert.match(
          structuredContent.consoleMessages[0].stackTrace ?? '',
          /at failingFn/,
        );
      });
    });

    it('omits stack traces by default', async () => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent(
          '<script>function failingFn() { console.error("This is an error"); } failingFn();</script>',
        );
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);
        assert.ok(textContent.includes('msgid=1 [error] This is an error'));
        assert.ok(!textContent.includes('at failingFn'));
        const structuredContent = formattedResponse.structuredContent as {
          consoleMessages: Array<{stackTrace?: string}>;
        };
        assert.strictEqual(
          structuredContent.consoleMessages[0].stackTrace,
          undefined,
        );
      });
    });

    it('work with primitive unhandled errors', async () => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent('<script>throw undefined;</script>');
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);
        assert.ok(textContent.includes('msgid=1 [error] Uncaught  (0 args)'));
      });
    });

    describe('issues', () => {
      it('lists issues', async () => {
        await withMcpContext(async (response, context, args) => {
          const page = context.getSelectedMcpPage();
          const issuePromise = new Promise<void>(resolve => {
            page.pptrPage.once('issue', () => {
              resolve();
            });
          });
          await page.pptrPage.setContent(
            '<input type="text" name="username" />',
          );
          await issuePromise;
          await listConsoleMessages(args).handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          );
          const formattedResponse = await response.handle(context);
          const textContent = getTextContent(formattedResponse.content[0]);
          assert.ok(
            textContent.includes(
              `msgid=1 [issue] An element doesn’t have an autocomplete attribute (count: 1)`,
            ),
          );
        });
      });

      it('lists issues after a page reload', async () => {
        await withMcpContext(async (response, context, args) => {
          const page = await context.newPage();
          response.setPage(page);
          const issuePromise = new Promise<void>(resolve => {
            page.pptrPage.once('issue', () => {
              resolve();
            });
          });

          await page.pptrPage.setContent(
            '<input type="text" name="username" />',
          );
          await issuePromise;
          await listConsoleMessages(args).handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          );
          {
            const formattedResponse = await response.handle(context);
            const textContent = getTextContent(formattedResponse.content[0]);
            assert.ok(
              textContent.includes(
                `msgid=1 [issue] An element doesn’t have an autocomplete attribute (count: 1)`,
              ),
            );
          }

          const anotherIssuePromise = new Promise<void>(resolve => {
            page.pptrPage.once('issue', () => {
              resolve();
            });
          });
          await page.pptrPage.reload();
          await page.pptrPage.setContent(
            '<input type="text" name="username" />',
          );
          await anotherIssuePromise;
          {
            const formattedResponse = await response.handle(context);
            const textContent = getTextContent(formattedResponse.content[0]);
            assert.ok(
              textContent.includes(
                `msgid=2 [issue] An element doesn’t have an autocomplete attribute (count: 1)`,
              ),
            );
          }
        });
      });

      it('when dialog is open', async t => {
        await withMcpContext(async (response, context, args) => {
          const page = context.getSelectedMcpPage().pptrPage;
          await page.setContent(
            '<script>console.log("Pre-dialog message")</script>',
          );

          const dialogPromise = new Promise<Dialog>(resolve => {
            page.on('dialog', dialog => resolve(dialog));
          });

          const evalPromise = page
            .evaluate(() => {
              alert('test dialog');
            })
            .catch(() => {
              // Ignore TargetCloseError when page is closed with open dialog
            });
          const dialog = await dialogPromise;

          try {
            await listConsoleMessages(args).handler(
              {params: {}, page: context.getSelectedMcpPage()},
              response,
              context,
            );

            const result = await response.handle(context);
            t.assert.snapshot(JSON.stringify(result));
          } finally {
            await dialog.dismiss();
            await evalPromise;
          }
        });
      });
    });
  });

  describe('get_console_message', () => {
    const server = serverHooks();

    it('gets a specific console message', async () => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent(
          '<script>console.error("This is an error")</script>',
        );
        // The list is needed to populate the console messages in the context.
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const textContent = getTextContent(formattedResponse.content[0]);
        assert.ok(
          textContent.includes('msgid=1 [error] This is an error'),
          'Should contain console message body',
        );
      });
    });

    it('formats special and cyclic arguments in get_console_message', async () => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.setContent(`
          <script>
            const cyc = {name: 'cyc'}; cyc.self = cyc;
            console.log('cyclic', cyc);
            console.log('sym', Symbol('s'));
            console.log('map', new Map([[1, 2]]), new Set([3]));
            console.log('date', new Date(0));
            console.log('fn', function foo() {});
            console.log('node', document.documentElement);
            console.log('plain', {a: 1});
          </script>
        `);
        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        for (let i = 1; i <= 7; i++) {
          const res = new McpResponse(args);
          res.setPage(context.getSelectedMcpPage());
          await getConsoleMessage(args).handler(
            {params: {msgid: i}, page: context.getSelectedMcpPage()},
            res,
            context,
          );
          const formatted = await res.handle(context);
          const text = getTextContent(formatted.content[0]);
          assert.strictEqual(
            text.includes('is no longer available'),
            false,
            `Message ${i} should not report argument as no longer available: ${text}`,
          );
          if (i === 1) {
            assert.ok(
              text.includes('"name":"cyc"') && text.includes('[Circular]'),
              `Message 1 should contain cyclic content: ${text}`,
            );
          } else if (i === 2) {
            assert.ok(
              text.includes('Symbol(s)'),
              `Message 2 should contain Symbol: ${text}`,
            );
          } else if (i === 3) {
            assert.ok(
              text.includes('1 => 2') && text.includes('3'),
              `Message 3 should contain Map and Set content: ${text}`,
            );
          } else if (i === 4) {
            assert.ok(
              text.includes('1970-01-01'),
              `Message 4 should contain date: ${text}`,
            );
          } else if (i === 5) {
            assert.ok(
              text.includes('foo'),
              `Message 5 should contain function name: ${text}`,
            );
          } else if (i === 6) {
            assert.ok(
              text.includes('html'),
              `Message 6 should contain html node: ${text}`,
            );
          } else if (i === 7) {
            assert.ok(
              text.includes('{"a":1}'),
              `Message 7 should contain plain JSON: ${text}`,
            );
          }
        }
      });
    });

    describe('issues type', () => {
      it('gets issue details with node id parsing', async t => {
        await withMcpContext(async (response, context, args) => {
          const page = context.getSelectedMcpPage();
          const issuePromise = new Promise<void>(resolve => {
            page.pptrPage.once('issue', () => {
              resolve();
            });
          });
          await page.pptrPage.setContent(
            '<input type="text" name="username" />',
          );
          page.textSnapshot = await TextSnapshot.create(page);
          await issuePromise;
          await listConsoleMessages(args).handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          );
          const response2 = new McpResponse(args);
          response2.setPage(context.getSelectedMcpPage());
          await getConsoleMessage(args).handler(
            {params: {msgid: 1}, page: context.getSelectedMcpPage()},
            response2,
            context,
          );
          const formattedResponse = await response2.handle(context);
          t.assert.snapshot(getTextContent(formattedResponse.content[0]));
        });
      });
      it('gets issue details with request id parsing', async t => {
        server.addRoute('/data.json', (_req, res) => {
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = 200;
          res.end(JSON.stringify({data: 'test data'}));
        });

        await withMcpContext(async (response, context, args) => {
          const page = context.getSelectedMcpPage();
          const issuePromise = new Promise<void>(resolve => {
            page.pptrPage.once('issue', () => {
              resolve();
            });
          });

          const url = server.getRoute('/data.json');
          await page.pptrPage.setContent(`
            <script>
              fetch('${url}', {
                  method: 'GET',
                  headers: {
                      'Content-Type': 'application/json',
                      'X-Custom-Header': 'MyValue'
                  }
              });
            </script>
          `);
          page.textSnapshot = await TextSnapshot.create(page);
          await issuePromise;
          const messages = page.getConsoleData();
          let issueMsg;
          for (const message of messages) {
            if (message instanceof DevTools.AggregatedIssue) {
              issueMsg = message;
              break;
            }
          }
          assert.ok(issueMsg);
          const id = response.getConsoleMessageStableId(issueMsg);
          assert.ok(id);
          await listConsoleMessages(args).handler(
            {params: {types: ['issue']}, page: context.getSelectedMcpPage()},
            response,
            context,
          );
          const response2 = new McpResponse(args);
          response2.setPage(context.getSelectedMcpPage());
          await getConsoleMessage(args).handler(
            {params: {msgid: id}, page: context.getSelectedMcpPage()},
            response2,
            context,
          );
          const formattedResponse = await response2.handle(context);
          const rawText = getTextContent(formattedResponse.content[0]);
          t.assert.snapshot(
            stabilizeResponseOutput(
              rawText
                .replaceAll(/ID: \d+/g, 'ID: <ID>')
                .replaceAll(/reqid=\d+/g, 'reqid=<reqid>'),
            ),
          );
        });
      });
    });

    it('applies source maps to stack traces of console messages', async t => {
      server.addRoute('/main.min.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.statusCode = 200;
        res.end(`function n(){console.warn("hello world")}function o(){n()}(function n(){o()})();
          //# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJiYXIiLCJjb25zb2xlIiwid2FybiIsImZvbyIsIklpZmUiXSwic291cmNlcyI6WyIuL21haW4uanMiXSwic291cmNlc0NvbnRlbnQiOlsiXG5mdW5jdGlvbiBiYXIoKSB7XG4gIGNvbnNvbGUud2FybignaGVsbG8gd29ybGQnKTtcbn1cblxuZnVuY3Rpb24gZm9vKCkge1xuICBiYXIoKTtcbn1cblxuKGZ1bmN0aW9uIElpZmUoKSB7XG4gIGZvbygpO1xufSkoKTtcblxuIl0sIm1hcHBpbmdzIjoiQUFDQSxTQUFTQSxJQUNQQyxRQUFRQyxLQUFLLGNBQ2YsQ0FFQSxTQUFTQyxJQUNQSCxHQUNGLEVBRUEsU0FBVUksSUFDUkQsR0FDRCxFQUZEIiwiaWdub3JlTGlzdCI6W119
          `);
      });
      server.addHtmlRoute(
        '/index.html',
        `<script src="${server.getRoute('/main.min.js')}"></script>`,
      );

      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.goto(server.getRoute('/index.html'));

        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const rawText = getTextContent(formattedResponse.content[0]);

        t.assert.snapshot(rawText);
      });
    });

    it('applies source maps to stack traces of uncaught exceptions', async t => {
      server.addRoute('/main.min.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.statusCode = 200;
        res.end(`function n(){throw new Error("b00m!")}function o(){n()}(function n(){o()})();
          //# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJiYXIiLCJFcnJvciIsImZvbyIsIklpZmUiXSwic291cmNlcyI6WyIuL21haW4uanMiXSwic291cmNlc0NvbnRlbnQiOlsiXG5mdW5jdGlvbiBiYXIoKSB7XG4gIHRocm93IG5ldyBFcnJvcignYjAwbSEnKTtcbn1cblxuZnVuY3Rpb24gZm9vKCkge1xuICBiYXIoKTtcbn1cblxuKGZ1bmN0aW9uIElpZmUoKSB7XG4gIGZvbygpO1xufSkoKTtcblxuIl0sIm1hcHBpbmdzIjoiQUFDQSxTQUFTQSxJQUNQLE1BQU0sSUFBSUMsTUFBTSxRQUNsQixDQUVBLFNBQVNDLElBQ1BGLEdBQ0YsRUFFQSxTQUFVRyxJQUNSRCxHQUNELEVBRkQiLCJpZ25vcmVMaXN0IjpbXX0=
        `);
      });
      server.addHtmlRoute(
        '/index.html',
        `<script src="${server.getRoute('/main.min.js')}"></script>`,
      );

      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.goto(server.getRoute('/index.html'));

        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const rawText = getTextContent(formattedResponse.content[0]);

        t.assert.snapshot(rawText);
      });
    });

    it('applies source maps to stack traces of Error object console.log arguments', async t => {
      server.addRoute('/main.min.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.statusCode = 200;
        res.end(`function n(){throw new Error("b00m!")}function o(){n()}(function n(){try{o()}catch(n){console.log("An error happened:",n)}})();
          //# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJiYXIiLCJFcnJvciIsImZvbyIsIklpZmUiLCJlIiwiY29uc29sZSIsImxvZyJdLCJzb3VyY2VzIjpbIi4vbWFpbi5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJcbmZ1bmN0aW9uIGJhcigpIHtcbiAgdGhyb3cgbmV3IEVycm9yKCdiMDBtIScpO1xufVxuXG5mdW5jdGlvbiBmb28oKSB7XG4gIGJhcigpO1xufVxuXG4oZnVuY3Rpb24gSWlmZSgpIHtcbiAgdHJ5IHtcbiAgICBmb28oKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIGNvbnNvbGUubG9nKCdBbiBlcnJvciBoYXBwZW5lZDonLCBlKTtcbiAgfVxufSkoKTtcblxuIl0sIm1hcHBpbmdzIjoiQUFDQSxTQUFTQSxJQUNQLE1BQU0sSUFBSUMsTUFBTSxRQUNsQixDQUVBLFNBQVNDLElBQ1BGLEdBQ0YsRUFFQSxTQUFVRyxJQUNSLElBQ0VELEdBQ0YsQ0FBRSxNQUFPRSxHQUNQQyxRQUFRQyxJQUFJLHFCQUFzQkYsRUFDcEMsQ0FDRCxFQU5EIiwiaWdub3JlTGlzdCI6W119
        `);
      });
      server.addHtmlRoute(
        '/index.html',
        `<script src="${server.getRoute('/main.min.js')}"></script>`,
      );

      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.goto(server.getRoute('/index.html'));

        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const rawText = getTextContent(formattedResponse.content[0]);

        t.assert.snapshot(rawText);
      });
    });

    it('applies source maps to stack traces of uncaught exceptions with cause', async t => {
      server.addRoute('/main.min.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.statusCode = 200;
        res.end(`function r(){throw new Error("b00m!")}function o(){try{r()}catch(r){throw new Error("bar failed",{cause:r})}}(function r(){try{o()}catch(r){throw new Error("foo failed",{cause:r})}})();
          //# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJiYXIiLCJFcnJvciIsImZvbyIsImUiLCJjYXVzZSIsIklpZmUiXSwic291cmNlcyI6WyIuL21haW4uanMiXSwic291cmNlc0NvbnRlbnQiOlsiXG5mdW5jdGlvbiBiYXIoKSB7XG4gIHRocm93IG5ldyBFcnJvcignYjAwbSEnKTtcbn1cblxuZnVuY3Rpb24gZm9vKCkge1xuICB0cnkge1xuICAgIGJhcigpO1xuICB9IGNhdGNoIChlKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdiYXIgZmFpbGVkJywgeyBjYXVzZTogZSB9KTtcbiAgfVxufVxuXG4oZnVuY3Rpb24gSWlmZSgpIHtcbiAgdHJ5IHtcbiAgICBmb28oKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBFcnJvcignZm9vIGZhaWxlZCcsIHsgY2F1c2U6IGUgfSk7XG4gIH1cbn0pKCk7XG5cbiJdLCJtYXBwaW5ncyI6IkFBQ0EsU0FBU0EsSUFDUCxNQUFNLElBQUlDLE1BQU0sUUFDbEIsQ0FFQSxTQUFTQyxJQUNQLElBQ0VGLEdBQ0YsQ0FBRSxNQUFPRyxHQUNQLE1BQU0sSUFBSUYsTUFBTSxhQUFjLENBQUVHLE1BQU9ELEdBQ3pDLENBQ0YsRUFFQSxTQUFVRSxJQUNSLElBQ0VILEdBQ0YsQ0FBRSxNQUFPQyxHQUNQLE1BQU0sSUFBSUYsTUFBTSxhQUFjLENBQUVHLE1BQU9ELEdBQ3pDLENBQ0QsRUFORCIsImlnbm9yZUxpc3QiOltdfQ==
        `);
      });
      server.addHtmlRoute(
        '/index.html',
        `<script src="${server.getRoute('/main.min.js')}"></script>`,
      );

      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.goto(server.getRoute('/index.html'));

        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const rawText = getTextContent(formattedResponse.content[0]);

        t.assert.snapshot(rawText);
      });
    });

    it('applies source maps to stack traces of Error object (with cause) console.log arguments', async t => {
      server.addRoute('/main.min.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.statusCode = 200;
        res.end(`function o(){throw new Error("b00m!")}function r(){try{o()}catch(o){throw new Error("bar failed",{cause:o})}}(function o(){try{r()}catch(o){console.log("foo failed",o)}})();
          //# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJiYXIiLCJFcnJvciIsImZvbyIsImUiLCJjYXVzZSIsIklpZmUiLCJjb25zb2xlIiwibG9nIl0sInNvdXJjZXMiOlsiLi9tYWluLmpzIl0sInNvdXJjZXNDb250ZW50IjpbIlxuZnVuY3Rpb24gYmFyKCkge1xuICB0aHJvdyBuZXcgRXJyb3IoJ2IwMG0hJyk7XG59XG5cbmZ1bmN0aW9uIGZvbygpIHtcbiAgdHJ5IHtcbiAgICBiYXIoKTtcbiAgfSBjYXRjaCAoZSkge1xuICAgIHRocm93IG5ldyBFcnJvcignYmFyIGZhaWxlZCcsIHsgY2F1c2U6IGUgfSk7XG4gIH1cbn1cblxuKGZ1bmN0aW9uIElpZmUoKSB7XG4gIHRyeSB7XG4gICAgZm9vKCk7XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmxvZygnZm9vIGZhaWxlZCcsIGUpO1xuICB9XG59KSgpO1xuXG4iXSwibWFwcGluZ3MiOiJBQUNBLFNBQVNBLElBQ1AsTUFBTSxJQUFJQyxNQUFNLFFBQ2xCLENBRUEsU0FBU0MsSUFDUCxJQUNFRixHQUNGLENBQUUsTUFBT0csR0FDUCxNQUFNLElBQUlGLE1BQU0sYUFBYyxDQUFFRyxNQUFPRCxHQUN6QyxDQUNGLEVBRUEsU0FBVUUsSUFDUixJQUNFSCxHQUNGLENBQUUsTUFBT0MsR0FDUEcsUUFBUUMsSUFBSSxhQUFjSixFQUM1QixDQUNELEVBTkQiLCJpZ25vcmVMaXN0IjpbXX0=
        `);
      });
      server.addHtmlRoute(
        '/index.html',
        `<script src="${server.getRoute('/main.min.js')}"></script>`,
      );

      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.goto(server.getRoute('/index.html'));

        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const rawText = getTextContent(formattedResponse.content[0]);

        t.assert.snapshot(rawText);
      });
    });

    it('does not apply source maps when sourceMaps is false', async () => {
      server.addRoute('/main.min.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.statusCode = 200;
        res.end(`function n(){throw new Error("b00m!")}function o(){n()}(function n(){o()})();
          //# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJiYXIiLCJFcnJvciIsImZvbyIsIklpZmUiXSwic291cmNlcyI6WyIuL21haW4uanMiXSwic291cmNlc0NvbnRlbnQiOlsiXG5mdW5jdGlvbiBiYXIoKSB7XG4gIHRocm93IG5ldyBFcnJvcignYjAwbSEnKTtcbn1cblxuZnVuY3Rpb24gZm9vKCkge1xuICBiYXIoKTtcbn1cblxuKGZ1bmN0aW9uIElpZmUoKSB7XG4gIGZvbygpO1xufSkoKTtcblxuIl0sIm1hcHBpbmdzIjoiQUFDQSxTQUFTQSxJQUNQLE1BQU0sSUFBSUMsTUFBTSxRQUNsQixDQUVBLFNBQVNDLElBQ1BGLEdBQ0YsRUFFQSxTQUFVRyxJQUNSRCxHQUNELEVBRkQiLCJpZ25vcmVMaXN0IjpbXX0=
        `);
      });
      server.addHtmlRoute(
        '/index.html',
        `<script src="${server.getRoute('/main.min.js')}"></script>`,
      );

      await withMcpContext(
        async (response, context, args) => {
          const page = context.getSelectedMcpPage();
          await page.pptrPage.goto(server.getRoute('/index.html'));

          await getConsoleMessage(args).handler(
            {params: {msgid: 1}, page: context.getSelectedMcpPage()},
            response,
            context,
          );
          const formattedResponse = await response.handle(context);
          const rawText = getTextContent(formattedResponse.content[0]);

          assert.ok(rawText.includes('main.min.js'));
          assert.ok(!rawText.includes('main.js'));
        },
        {sourceMaps: false},
      );
    });

    it('ignores frames from ignore listed URLs', async t => {
      server.addHtmlRoute(
        '/index.html',
        `<!DOCTYPE html>
         <script>
         function ignoredFn1(cb) {
          ignoredFn2(cb);
         }

         function ignoredFn2(cb) {
          cb();
         }
         //# sourceURL=./node_modules/foo.js
         </script>
         <script>
          function callback() {
            console.log('hello from callback');
          }

          (function callIt() {
            ignoredFn1(callback);
          })();
         //# sourceURL='main.js'
         </script>
        `,
      );

      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage();
        await page.pptrPage.goto(server.getRoute('/index.html'));

        await getConsoleMessage(args).handler(
          {params: {msgid: 1}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        const formattedResponse = await response.handle(context);
        const rawText = getTextContent(formattedResponse.content[0]);

        t.assert.snapshot(rawText);
      });
    });

    it('when dialog is open', async t => {
      await withMcpContext(async (response, context, args) => {
        const page = context.getSelectedMcpPage().pptrPage;
        await page.setContent(
          '<script>console.error("This is an error")</script>',
        );

        await listConsoleMessages(args).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const dialogPromise = new Promise<Dialog>(resolve => {
          page.on('dialog', dialog => resolve(dialog));
        });
        const evalPromise = page
          .evaluate(() => {
            alert('test dialog');
          })
          .catch(() => {
            // Ignore TargetCloseError when page is closed with open dialog
          });
        const dialog = await dialogPromise;

        try {
          await getConsoleMessage(args).handler(
            {params: {msgid: 1}, page: context.getSelectedMcpPage()},
            response,
            context,
          );

          const result = await response.handle(context);
          t.assert.snapshot(
            stabilizeStructuredContent(result.structuredContent),
          );
        } finally {
          await dialog.dismiss();
          await evalPromise;
        }
      });
    });
  });
});
