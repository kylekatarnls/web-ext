import fs from 'fs';
import path from 'path';

import { queue } from 'async';
import Zip from 'jszip';

// Limiting the number of files read at the same time
const maxOpenFiles = 500;

export function zipDir(rootDir, options, callback) {
  let promise;
  let succeed;
  let fail;

  if (!callback && typeof options === 'function') {
    callback = options;
    options = {};
  }
  options = options || {};

  if (!callback) {
    promise = new Promise(function (resolve, reject) {
      succeed = resolve;
      fail = reject;
    });
  }

  zipBuffer(rootDir, options, function (err, buffer) {
    if (!err && options.saveTo) {
      fs.writeFile(options.saveTo, buffer, { encoding: 'binary' }, finish);
    } else {
      finish(err);
    }

    function finish(error) {
      if (callback) {
        callback(error, buffer);
      } else {
        if (error) {
          fail(error);
        } else {
          succeed(buffer);
        }
      }
    }
  });

  return promise;
}

function collectFileStatRecursively(directory, fileStats = {}) {
  return new Promise(function (resolve, reject) {
    fs.readdir(directory, function (dirErr, files) {
      if (dirErr) {
        reject(dirErr);

        return;
      }

      if (!files.length) {
        resolve([]);

        return;
      }

      Promise.all(
        files.map(function (file) {
          const fullPath = path.resolve(directory, file);

          return new Promise(function (fileResolve) {
            fs.stat(fullPath, function (err, stat) {
              if (err) {
                reject(err);

                return;
              }

              fileStats[fullPath] = stat;

              if (!stat.isDirectory()) {
                fileResolve();

                return;
              }

              collectFileStatRecursively(fullPath, fileStats).then(fileResolve);
            });
          });
        }),
      ).then(function () {
        resolve(fileStats);
      });
    });
  });
}

function getFilesRecursively(directory) {
  return collectFileStatRecursively(directory).then(function (fileStats) {
    const result = Object.keys(fileStats);
    result.sort();

    return result.map(function (fullPath) {
      return { fullPath, stat: fileStats[fullPath] };
    });
  });
}

function zipBuffer(rootDir, options, callback) {
  const zip = new Zip();
  const folders = {};
  // Resolve the path so we can remove trailing slash if provided
  rootDir = path.resolve(rootDir);

  getFilesRecursively(rootDir)
    .then(function (files) {
      folders[rootDir] = zip;

      files.forEach(function ({ fullPath, stat }) {
        if (options.filter && !options.filter(fullPath, stat)) {
          return;
        }

        if (stat.isDirectory()) {
          if (options.each) {
            options.each(fullPath);
          }
          folders[fullPath] = folders[path.dirname(fullPath)].folder(fullPath);
        }
      });

      return Promise.all(files.map(function ({ fullPath, stat }) {
        return new Promise(function (resolve, reject) {
          if (
            stat.isDirectory() ||
            (options.filter && !options.filter(fullPath, stat))
          ) {
            resolve();

            return;
          }

          const dir = path.dirname(fullPath);
          const file = path.basename(fullPath);

          fileQueue.push({ fullPath, dir, file, date: stat.mtime }, function (error) {
            if (error) {
              reject(error);

              return;
            }

            resolve();
          });
        });
      }));
    })
    .then(function () {
      zip
        .generateAsync({
          compression: 'DEFLATE',
          type: 'nodebuffer',
        })
        .then(function (buffer) {
          callback(null, buffer);
        })
        .catch(function (error) {
          callback(error);
        });
    })
    .catch(callback);

  const fileQueue = queue(function (task, queueCallback) {
    fs.readFile(task.fullPath, function (err, data) {
      if (options.each) {
        options.each(path.join(task.dir, task.file));
      }

      if (!folders[task.dir]) {
        // If absent, it means options.filter filtered the parent folder out
        queueCallback();

        return;
      }

      folders[task.dir].file(task.file, data, {
        date: task.date,
        createFolders: false,
      });
      queueCallback(err);
    });
  }, maxOpenFiles);
}
