#include "MeasurementCacheUnderTest.h"
#import <Foundation/Foundation.h>
#include <cstring>

static NSMutableArray<dispatch_block_t> *background;
static NSMutableArray<dispatch_block_t> *mainQueue;

static void enqueue(dispatch_queue_t queue, dispatch_block_t block)
{
  [(queue == dispatch_get_main_queue() ? mainQueue : background) addObject:[block copy]];
}

// Control queue progress deterministically while executing the installed coordinator itself.
#define dispatch_async enqueue
#include "ENRMAsyncRenderCoordinator.m"
#undef dispatch_async

static void check(BOOL condition, const char *message)
{
  if (!condition)
  {
    fprintf(stderr, "FAIL: %s\n", message);
    exit(1);
  }
}

static void drain(NSMutableArray<dispatch_block_t> *queue)
{
  while (queue.count)
  {
    dispatch_block_t block = queue.firstObject;
    [queue removeObjectAtIndex:0];
    block();
  }
}

static void testCoordinator(void)
{
  background = [NSMutableArray new];
  mainQueue = [NSMutableArray new];
  ENRMAsyncRenderCoordinator *coordinator = [[ENRMAsyncRenderCoordinator alloc] initWithQueueLabel:"test"];
  __block NSUInteger rendered = 0;
  __block NSUInteger applied = 0;
  __weak NSObject *obsolete;
  @autoreleasepool
  {
    NSObject *document = [NSObject new];
    obsolete = document;
    [coordinator
        scheduleRender:^BOOL {
          (void)[document description];
          return YES;
        }
                 apply:^{
                 }];
  }
  for (NSUInteger revision = 1; revision <= 1000; revision++)
  {
    [coordinator
        scheduleRender:^BOOL {
          rendered++;
          return YES;
        }
        apply:^{
          applied = revision;
        }];
  }
  printf("coordinator pending workers: %lu; obsolete document retained: %s\n",
         (unsigned long)background.count, obsolete ? "yes" : "no");
  check(obsolete == nil, "superseded pending documents must be released before the worker runs");
  check(background.count == 1, "a burst must enqueue one worker, not one closure per revision");
  drain(background);
  drain(mainQueue);
  check(rendered == 1 && applied == 1000, "only the latest pending revision may parse and apply");

  NSMutableArray<NSString *> *renders = [NSMutableArray new];
  NSMutableArray<NSString *> *applies = [NSMutableArray new];
  [coordinator
      scheduleRender:^BOOL {
        [renders addObject:@"in-flight"];
        [coordinator
            scheduleRender:^BOOL {
              [renders addObject:@"obsolete"];
              return YES;
            }
            apply:^{
              [applies addObject:@"obsolete"];
            }];
        [coordinator
            scheduleRender:^BOOL {
              [renders addObject:@"latest"];
              return YES;
            }
            apply:^{
              [applies addObject:@"latest"];
            }];
        return YES;
      }
      apply:^{
        [applies addObject:@"in-flight"];
      }];
  drain(background);
  drain(mainQueue);
  check([renders isEqual:@[ @"in-flight", @"latest" ]],
        "work arriving during a render must replace the pending revision");
  check([applies isEqual:@[ @"latest" ]], "a completed superseded render must never apply");

  [coordinator
      scheduleRender:^BOOL {
        rendered++;
        return YES;
      }
      apply:^{
        applied++;
      }];
  [coordinator invalidate];
  drain(background);
  drain(mainQueue);
  check(rendered == 1 && applied == 1000, "recycling must discard pending parsing and application");

  [coordinator
      scheduleRender:^BOOL {
        return NO;
      }
      apply:^{
        applied++;
      }];
  drain(background);
  drain(mainQueue);
  check(applied == 1000, "failed renders must not apply");
  coordinator.blockAsyncRender = YES;
  [coordinator
      scheduleRender:^BOOL {
        rendered++;
        return YES;
      }
      apply:^{
        applied++;
      }];
  check(background.count == 0, "synchronous render mode must suppress scheduling");
  coordinator.blockAsyncRender = NO;
  [coordinator
      scheduleRender:^BOOL {
        rendered++;
        return YES;
      }
      apply:^{
        applied++;
      }];
  drain(background);
  [coordinator invalidate];
  drain(mainQueue);
  check(rendered == 2 && applied == 1000, "invalidation must also suppress an already completed render");
  printf("PASS coordinator: 1001 pending revisions -> 1 parse, obsolete captures released; in-flight "
         "replacement/invalidation/failure covered\n");
}

static void testCache(void)
{
  using namespace facebook::react;
  auto &cache = MeasurementCache::shared();
  CachedSize size;
  MeasurementCacheKey key{};
  key.markdown = std::string(100 * 1024, 'x');
  for (int revision = 0; revision < 512; revision++)
  {
    key.markdown += "x";
    cache.set(key, {double(revision), 20});
  }
  check(cache.get(key, size) && size.width == 511, "latest streamed measurement must remain available");
  NSUInteger retained = 0;
  size_t retainedMarkdownBytes = 0;
  for (int revision = 0; revision < 512; revision++)
  {
    key.markdown = std::string(100 * 1024 + revision + 1, 'x');
    if (cache.get(key, size))
    {
      retained++;
      retainedMarkdownBytes += 2 * key.markdown.size();
    }
  }
  printf("cache retained prefixes: %lu; duplicated markdown bytes: %zu\n", (unsigned long)retained,
         retainedMarkdownBytes);
  check(retained > 0 && retained <= 64,
        "streamed prefixes must obey a byte budget, not only a 512-entry limit");

  MeasurementCacheKey huge{};
  huge.markdown = std::string(5 * 1024 * 1024, 'z');
  cache.set(huge, {1, 1});
  check(!cache.get(huge, size), "one document larger than the budget must bypass retention");
  huge.markdown = "regex-heavy";
  huge.linkRegexKey = std::string(5 * 1024 * 1024, 'r');
  cache.set(huge, {1, 1});
  check(!cache.get(huge, size), "the byte budget must include non-markdown key strings");

  check(cache.get(key, size), "oversized entries must not evict useful cached measurements");
  cache.set(key, {123, 456});
  check(cache.get(key, size) && size.width == 123 && size.height == 456,
        "updating a cache hit must preserve the new size");
  cache.removeMatchingMarkdown(key.markdown);
  check(!cache.get(key, size), "removing a document must remove its cached measurements");
  cache.set(key, {789, 10});
  check(cache.get(key, size) && size.width == 789, "removed capacity must be reusable");

  for (int revision = 0; revision < 512; revision++)
  {
    key.markdown = std::string(100 * 1024 + revision + 1, 'x');
    cache.removeMatchingMarkdown(key.markdown);
  }
  for (int entry = 0; entry < 512; entry++)
  {
    key.markdown = std::to_string(entry);
    cache.set(key, {double(entry), 1});
  }
  key.markdown = "0";
  check(cache.get(key, size), "the entry limit must still allow 512 small documents");
  key.markdown = "new";
  cache.set(key, {1000, 1});
  key.markdown = "1";
  check(!cache.get(key, size), "overflow must evict the least recently used document");
  key.markdown = "0";
  check(cache.get(key, size), "reading a cache hit must refresh its LRU position");
  printf("PASS cache: 512 x ~100 KiB prefixes -> %lu retained, %zu duplicated markdown bytes; oversized keys "
         "bypassed\n",
         (unsigned long)retained, retainedMarkdownBytes);
}

int main(int argc, const char *argv[])
{
  @autoreleasepool
  {
    if (argc == 1 || strcmp(argv[1], "cache") == 0)
      testCache();
    if (argc == 1 || strcmp(argv[1], "coordinator") == 0)
      testCoordinator();
  }
}
