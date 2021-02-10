const fire = require('js-fire');
const fs = require('fs');
const path = require('path');
const fetch = require('isomorphic-fetch');
const _get = require('lodash.get');
const { Signale } = require('signale');
const { crawlRepo, crawlerDomMatcher } = require('./crawlRepo');
const signale = new Signale({ scope: 'star-search' });
const interactive = new Signale({ interactive: true, scope: 'star-search' });
const search = require('./search');
const {
  githubPersonalAccessToken,
  reposFilePath,
  pageContetFilePath,
  errorRetryMs,
  errorRetryTimes,
} = require('./env');

const starsearch = {
  __description__:
    'Search your github stared repos with ease. Get token at https://github.com/settings/tokens with permission "public_repo"',
  update: async (token) => {
    if (!githubPersonalAccessToken && !token) {
      throw new Error(
        `github personal access token requried!\n
        star-search start --token=<token>
        https://help.github.com/en/articles/creating-a-personal-access-token-for-the-command-line`,
      );
    }
    if (token) {
      fs.writeFileSync(
        path.join(__dirname, '..', '.env'),
        `GITHUB_PERSONAL_ACCESS_TOKEN=${token}`,
      );
    }
    await writeAllReposToFile(reposFilePath, token);
    await readFromFileAndParseToReadme(reposFilePath, pageContetFilePath);
  },
  search: (keyword) => {
    search(keyword);
  },
};

fire(starsearch);

function wait(ms = 500) {
  return new Promise((resolve) =>
    setTimeout(() => {
      resolve();
    }, ms),
  );
}

async function writeAllReposToFile(reposFilePath, token) {
  let allRepos = [];
  // 100 is the API limit of each request
  const getReposBatch = async (afterCursor = '', first = 100) => {
    try {
      const res = await fetch(`https://api.github.com/graphql`, {
        method: 'POST', // *GET, POST, PUT, DELETE, etc.
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token || githubPersonalAccessToken}`,
          // 'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: JSON.stringify({
          query: `{ viewer { starredRepositories(first:${first},${
            afterCursor && `after:"${afterCursor}"`
          } orderBy:{field:STARRED_AT,direction:ASC},){ pageInfo{ hasNextPage startCursor endCursor } nodes{ name url } totalCount } } }`,
        }),
      });

      /**
       * sample response data
       * {
          "data": {
            "viewer": {
              "starredRepositories": {
                "pageInfo": {
                  "hasNextPage": true,
                  "startCursor": "Y3Vyc29yOnYyOpK5MjAxNi0wNy0wMVQxODo1NTowNSswODowMM4DuIeg",
                  "endCursor": "Y3Vyc29yOnYyOpK5MjAxNi0wOC0xOFQxNzowMDowOCswODowMM4D7bX2"
                },
                "nodes": [
                  {
                    "name": "freeCodeCamp",
                    "url": "https://github.com/freeCodeCamp/freeCodeCamp"
                  },
                  {
                    "name": "node-uglifier",
                    "url": "https://github.com/zsoltszabo/node-uglifier"
                  }
                ],
                "totalCount": 1026
              }
            }
          }
        }
       */
      const data = await res.json();
      if (_get(data, 'message', '') === 'Bad credentials') {
        throw new Error('Bad credentials, maybe wrong token');
      }
      const starredRepositories = _get(
        data,
        'data.viewer.starredRepositories',
        {},
      );
      const totalCount = _get(starredRepositories, 'totalCount', 0);
      const hasNextPage = _get(
        starredRepositories,
        'pageInfo.hasNextPage',
        false,
      );
      const endCursor = _get(starredRepositories, 'pageInfo.endCursor', '');
      const nodes = _get(starredRepositories, 'nodes', []);
      allRepos = allRepos.concat(nodes);

      interactive.await(
        `Fetching Star repositories [%d/%d]`,
        allRepos.length,
        totalCount,
      );
      if (allRepos.length === totalCount) {
        interactive.success(
          `Fetching Star repositories [%d/%d]`,
          allRepos.length,
          totalCount,
        );
      }

      await wait();

      if (hasNextPage) {
        await getReposBatch(endCursor);
      }
    } catch (err) {
      signale.error(err);
    }
  };
  await getReposBatch();
  fs.writeFileSync(reposFilePath, JSON.stringify(allRepos));
  signale.complete(`Saved file to ${reposFilePath}`);
}

async function readFromFileAndParseToReadme(filePath, pageContetFilePath) {
  const allRepos = JSON.parse(fs.readFileSync(filePath).toString());
  let batchCount = 1;
  const batchSize = +process.env.REQUEST_BATCH_SIZE || 10;
  let batchRepos = [];
  let allRepoPageContents = [];
  for (let i = 0; i < allRepos.length; ++i) {
    const repo = allRepos[i];
    const repoName = repo.name || '';
    let repoUrl = repo.url;
    if (!repoUrl || !repoName) {
      break;
    }
    batchRepos.push(repo);
    ++batchCount;

    if ((i + 1) % batchSize === 0 || i === allRepos.length - 1) {
      if (i === allRepos.length - 1) {
        interactive.success(
          `Crawling page content No. [%s/%d]`,
          `${batchCount - batchSize <= 0 ? 1 : batchCount - batchSize}-${
            batchCount - 1
          }`,
          allRepos.length,
        );
      } else {
        interactive.await(
          `Crawling page content No. [%s/%d]`,
          `${batchCount - batchSize <= 0 ? 1 : batchCount - batchSize}-${
            batchCount - 1
          }`,
          allRepos.length,
        );
      }
      await Promise.all(
        batchRepos.map((repo) => {
          return xRequestRetry(repo, repo.url, crawlerDomMatcher);
        }),
      );
      batchRepos = [];

      async function xRequestRetry(repo, ...args) {
        let retryCount = 1;

        await xRequest();

        async function xRequest() {
          try {
            if (retryCount >= errorRetryTimes) {
              return allRepoPageContents.push({
                url: repo.url,
                name: repo.name,
                description: 'network error',
                readme: 'network error',
              });
            }

            const data = await crawlRepo(repo, ...args);
            allRepoPageContents.push(data);
          } catch (err) {
            ++retryCount;
            if (retryCount < errorRetryTimes) {
              signale.info(
                `network error, retrying... retryCount ${retryCount}`,
              );
              await wait(errorRetryMs);
              await xRequest(...args);
            }
          }
        }
      }
    }
  }
  fs.writeFileSync(pageContetFilePath, JSON.stringify(allRepoPageContents));
  signale.complete(`Saved file to ${pageContetFilePath}`);
  signale.info(`Try search by "star-search search --keyword 'express'"`);
}
