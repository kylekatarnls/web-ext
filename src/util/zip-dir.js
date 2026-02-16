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

function zipBuffer(rootDir, options, callback) {
  const zip = new Zip();
  const folders = {};
  // Resolve the path so we can remove trailing slash if provided
  rootDir = path.resolve(rootDir);

  folders[rootDir] = zip;

  dive(rootDir, function (err) {
    if (err) {
      return callback(err);
    }

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
  });

  function dive(dir, diveCallback) {
    fs.readdir(dir, function (dirErr, files) {
      if (dirErr) {
        return diveCallback(dirErr);
      }
      if (!files.length) {
        return diveCallback();
      }
      let count = files.length;
      files.sort();
      Promise.all(files.map(function (file) {
        return new Promise(function (resolve) {
          const fullPath = path.resolve(dir, file);
          fs.stat(fullPath, function (err, stat) {
            resolve({fullPath, err, stat});
          });
        });
      })).forEach(function ({fullPath, err, stat}) {
        addItem(fullPath, stat, err, function (error) {
          if (!--count) {
            diveCallback(error);
          }
        });
      });
    });
  }

  const fileQueue = queue(function (task, queueCallback) {
    fs.readFile(task.fullPath, function (err, data) {
      if (options.each) {
        options.each(path.join(task.dir, task.file));
      }
      folders[task.dir].file(task.file, data, {
        date: task.date,
        createFolders: false,
      });
      queueCallback(err);
    });
  }, maxOpenFiles);

  function addItem(fullPath, stat, err, cb) {
    if (err) {
      return cb(err);
    }
    if (options.filter && !options.filter(fullPath, stat)) {
      return cb();
    }
    const dir = path.dirname(fullPath);
    const file = path.basename(fullPath);
    let parentZip;
    if (stat.isDirectory()) {
      parentZip = folders[dir];
      if (options.each) {
        options.each(fullPath);
      }
      folders[fullPath] = parentZip.folder(file);
      dive(fullPath, cb);
    } else {
      fileQueue.push({ fullPath, dir, file, date: stat.mtime }, cb);
    }
  }
}
