const { Index, Queue } = require("taskcluster-client-web");

const timeout = 30 * 1000;
const retries = 5;
const delayFactor = 100;
const randomizationFactor = 0.25;
const maxDelay = 30 * 1000;

const rootUrl = "https://firefox-ci-tc.services.mozilla.com/";

function createFilters(filters) {
  const positive = filters.filter((re) => !re.startsWith("!"));
  const negative = filters
    .filter((re) => re.startsWith("!"))
    .map((re) => re.slice(1));
  const regexes = [];
  let mod = (v) => v;
  for (const filter of positive) {
    const re = new RegExp(filter);
    regexes.push({ re, mod });
  }

  mod = (v) => !v;
  for (const filter of negative) {
    const re = new RegExp(filter);
    regexes.push({ re, mod });
  }

  return regexes;
}

async function fetchJSON(url, headers) {
  const response = await fetch(url, { headers });
  return await response.json();
}

export class Progress {
  #queue = new Queue({
    rootUrl,
    timeout,
    retries,
    delayFactor,
    randomizationFactor,
    maxDelay,
  });

  #index = new Index({
    rootUrl,
    timeout,
    retries,
    delayFactor,
    randomizationFactor,
    maxDelay,
  });

  #channel = "mozilla-central";
  #hg = "";
  #commit = "tip";

  #regexes = [/-web-platform-tests-|-spidermonkey-/];

  #year = "2025";

  #remote = false;

  #scan = false;

  #filter({ task }) {
    return this.#regexes.every(({ re, mod }) =>
      mod(task.metadata.name.match(re))
    );
  }

  #log = () => {};

  get interopURL() {
    console.log(
      "Warning, not possible to fetch interop data remotely, falling back on local copy"
    );
    return this.#remote && false
      ? new URL("https://wpt.fyi/components/interop-data.js")
      : new URL("static/interop-data.json", location.href);
  }

  get metadataURL() {
    return this.#remote
      ? new URL(
          "https://wpt.fyi/api/metadata?includeTestLevel=true&product=firefox"
        )
      : new URL("static/metadata.json", location.href);
  }

  get categoryURL() {
    return new URL(
      "https://raw.githubusercontent.com/web-platform-tests/results-analysis/main/interop-scoring/category-data.json"
    );
  }

  get categoriesJSON() {
    return fetchJSON(this.categoryURL);
  }

  get interopJSON() {
    return fetchJSON(this.interopURL);
  }

  get metadataJSON() {
    return fetchJSON(this.metadataURL);
  }

  constructor(channel, { filters, commit, year, remote, log, scan } = {}) {
    if (channel) {
      this.#channel = channel;
    }

    this.#commit = commit ?? this.#commit;

    this.#year = year ?? this.#year;

    if (filters && filters.length && filters.join === Array.prototype.join) {
      this.#regexes = createFilters(filters);
    }

    if (log) {
      this.#log = log;
    }

    this.#hg = `https://hg.mozilla.org/${(() => {
      switch (this.#channel) {
        case "autoland":
        case "mozilla-inbound":
          return `integration/${this.#channel}`;
        case "mozilla-beta":
        case "mozilla-release":
          return `releases/${this.#channel}`;
        default:
          return this.#channel;
      }
    })()}`;

    this.#remote = !!remote;

    this.#scan = !!scan;
  }

  get commit() {
    return this.#commit;
  }

  async *#getCommits() {
    let ref = this.commit;
    while (ref) {
      const response = await fetch(`${this.#hg}/json-shortlog/${ref}`);
      const log = await response.json();
      if (log.error) {
        yield { error: log.error };
        return;
      }
      for (const { node } of log.changesets) {
        yield node;
      }
      ref = log.changesets.pop()?.parents?.shift();
    }
  }

  async getCommitDescription() {
    let description = `Not found`;
    let commit = this.commit.substring(0, 10);
    let href = "";
    try {
      const response = await fetch(`${this.#hg}/json-changeset/${this.commit}`);
      const json = await response.json();
      description = `${json.desc}`;
      href = `${this.#hg}/changeset/${this.commit}`;
    } catch (_) {}

    return { commit, description, href };
  }

  async #getRevisions() {
    let continuationToken = undefined;
    const revisions = {};
    let count = 0;
    const path = `gecko.v2.${this.#channel}.revision`;
    do {
      const result = await this.#index.listNamespaces(path, {
        continuationToken,
      });
      continuationToken = result.continuationToken;
      for (const value of result.namespaces) {
        revisions[value.name] = value.namespace;
        ++count;
      }
    } while (continuationToken);
    return { revisions, count };
  }

  async completedTasks() {
    this.#log(`Getting revisions`);
    const { revisions, count } = await this.#getRevisions();
    this.#log(`Got ${count} revisions`);
    let size = count;
    this.#log(`Finding first completed task`);
    while (size) {
      for await (const commit of this.#getCommits()) {
        this.#log(`Checking if ${commit} has completed`);
        if (commit.error) {
          throw new Error(commit.error);
        }
        if (!(commit in revisions)) {
          continue;
        }

        const { taskId } = await this.#index.findTask(
          `gecko.v2.${this.#channel}.revision.${commit}.taskgraph.decision`
        );

        let continuationToken = undefined;
        let complete = true;
        let completedTasks = new Set();
        do {
          const result = await this.#queue.listTaskGroup(taskId, {
            continuationToken,
          });
          continuationToken = result.continuationToken;
          const tasks = result.tasks.filter(this.#filter, this);
          complete = tasks.every(({ status }) => {
            switch (status.state) {
              case "failed":
              case "completed":
                return true;
              default:
                return false;
            }
          });

          if (!complete) {
            break;
          }
          completedTasks = completedTasks.union(new Set(tasks));
        } while (continuationToken);

        size--;

        if (!complete) {
          if (this.#scan) {
            continue;
          }
          throw new Error(`Commit ${commit} is not complete`);
        }

        return { tasks: completedTasks, commit };
      }
    }
  }

  #storeCompletedTasks(tasks) {
    localStorage.setItem(
      `${this.#commit}@${this.#channel}`,
      JSON.stringify({ tasks })
    );
  }

  #restoreCompletedTasks() {
    const data = localStorage.getItem(`${this.#commit}@${this.#channel}`);
    return JSON.parse(data);
  }

  async getCompletedTasks() {
    const data = this.#restoreCompletedTasks();
    if (data) {
      this.#log("Use previously fetched completed tasks");
      const { tasks } = data;
      const commit = this.#commit;
      return { tasks: new Set(tasks), commit };
    }
    const result = await this.completedTasks();
    this.#commit = result.commit;

    this.#storeCompletedTasks(Array.from(result.tasks.values()));

    return result;
  }

  async downloadArtifacts(tasks) {
    this.#log("Downloading artifacts");
    const filename = "wptreport.json";
    const urls = [];
    for (const task of tasks) {
      const { artifacts } = await this.#queue.listLatestArtifacts(
        task.status.taskId
      );
      for (const artifact of artifacts.filter(({ name }) =>
        name.endsWith(filename)
      )) {
        urls.push(
          new URL(
            `api/${this.#queue.options.serviceName}/${
              this.#queue.options.serviceVersion
            }/task/${task.status.taskId}/artifacts/${artifact.name}`,
            this.#queue.options.rootUrl
          )
        );
      }
    }
    const downloads = [];
    for (const url of urls) {
      downloads.push(fetch(url).then((response) => response.json()));
    }

    return await Promise.all(downloads);
  }

  async getExpectedTests() {
    this.#log("Getting expected tests");
    const year = this.#year;
    const categoriesJSON = await this.categoriesJSON;
    const interopJSON = await this.interopJSON;
    const labelledTestsJSON = await this.metadataJSON;

    const year_categories = new Map(
      Object.entries(interopJSON[year].focus_areas).filter(
        ([_, value]) => value.countsTowardScore
      )
    );

    const categories = categoriesJSON[year].categories.filter((item) =>
      year_categories.has(item.name)
    );

    const labelledTests = new Map();
    for (const [test, metadata] of Object.entries(labelledTestsJSON)) {
      for (const metaitem of metadata) {
        if ("label" in metaitem) {
          const entry = labelledTests.get(metaitem.label) ?? new Set();
          labelledTests.set(metaitem.label, entry);
          entry.add(test);
        }
      }
    }

    let expectedTests = new Set();
    let expectedCategories = {};
    let expectedCategoryDescriptions = {};
    for (const { name, labels } of categories) {
      let tests = new Set();
      for (const label of labels) {
        const labelledTest = labelledTests.get(label);
        tests = tests.union(labelledTest);
      }

      expectedCategories[name] = tests;
      const description = year_categories.get(name).description;
      expectedCategoryDescriptions[name] = { description };
      expectedTests = expectedTests.union(tests);
    }

    const expectedFailures = new Map();
    return {
      expectedCategories,
      expectedCategoryDescriptions,
      expectedTests,
      expectedFailures,
    };
  }

  loadTests(wptreports, expected) {
    this.#log("Loading tests");
    const result = new Map();
    for (const { results } of wptreports) {
      for (const entry of results) {
        const { test, status } = entry;
        if (!expected.has(test)) {
          continue;
        }

        if (status === "SKIP") {
          continue;
        }

        if (result.has(test)) {
          console.log(`${test} recorded multiple times`);
        }

        result.set(test, entry);
      }
    }

    return result;
  }

  getExpectedCategoriesByTest(expectedCategories) {
    this.#log("Getting expected test categories");
    const categoriesByTest = new Map();
    for (const [category, tests] of Object.entries(expectedCategories)) {
      for (const test of tests) {
        let entry = categoriesByTest.get(test);
        if (!entry) {
          entry = [];
          categoriesByTest.set(test, entry);
        }
        entry.push(category);
      }
    }

    return categoriesByTest;
  }

  isFailure(status) {
    if (!status || !status.length) {
      return true;
    }

    switch (status) {
      case "OK":
      case "PASS":
        return false;
      default:
        return true;
    }
  }

  score_test(results) {
    const count = results.subtests?.length ?? 0;
    if (count) {
      if (this.isFailure(results.status)) {
        return 0;
      }

      const subscore = results.subtests.reduce(
        (score, subtest) => score + this.score_test(subtest),
        0
      );
      return subscore / count;
    }

    if (results.status === "PASS") {
      return 1;
    }

    return 0;
  }

  computeScore(tests, expectedCategories) {
    this.#log("Computing score");
    const categoriesByTest =
      this.getExpectedCategoriesByTest(expectedCategories);
    const failures = new Set(categoriesByTest.keys());

    const scores = new Map(
      Object.entries(expectedCategories).map(([category, tests]) => {
        return [category, { score: 0, total: tests.size }];
      })
    );

    for (const [test, results] of tests.entries()) {
      const categories = categoriesByTest.get(test);

      const score = this.score_test(results);
      for (const category of categories) {
        const entry = scores.get(category);
        entry.score += score;
      }

      if (score == 1) {
        failures.delete(test);
      }
    }

    return { scores, failures, total: categoriesByTest.size };
  }
}
