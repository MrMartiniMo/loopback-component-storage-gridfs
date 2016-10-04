var util = require('util');
var url = require('url');

var _ = require('lodash');
var Busboy = require('busboy');
var GridFS = require('gridfs-stream');
var ZipStream = require('zip-stream');

var mongodb = require('mongodb');
var MongoClient = mongodb.MongoClient;

module.exports = GridFSService;

function GridFSService(options) {
  if (!(this instanceof GridFSService)) {
    return new GridFSService(options);
  }

  this.options = options;
}

/**
 * Connect to mongodb if necessary.
 */
GridFSService.prototype.connect = function (cb) {
  var self = this;

  if (!this.db) {
    var url;
    if (!self.options.url) {
      url = (self.options.username && self.options.password) ?
        'mongodb://{$username}:{$password}@{$host}:{$port}/{$database}' :
        'mongodb://{$host}:{$port}/{$database}';

      // replace variables
      url = url.replace(/\{\$([a-zA-Z0-9]+)\}/g, function (pattern, option) {
        return self.options[option] || pattern;
      });
    } else {
      url = self.options.url;
    }

    // connect
    MongoClient.connect(url, self.options, function (error, db) {
      if (!error) {
        self.db = db;
      }
      return cb(error, db);
    });
  }
};

/**
 * List all storage containers.
 */
GridFSService.prototype.getContainers = function (cb) {
  var collection = this.db.collection('fs.files');

  collection.find({
    'metadata.container': { $exists: true }
  }).toArray(function (error, files) {
    var containerList = [];

    if (!error) {
      containerList = _(files)
        .map('metadata.container').uniq().value();
    }

    return cb(error, containerList);
  });
};


/**
 * Delete an existing storage container.
 */
GridFSService.prototype.deleteContainer = function (containerName, cb) {
  var fs_files = this.db.collection('fs.files');
  var fs_chunks = this.db.collection('fs.chunks');

  fs_files.find({ 'metadata.container': containerName }, { _id: 1 }).toArray(function (error, containerFiles) {
    var files = [];
    for (var index in containerFiles) {
      files.push(containerFiles[index]._id);
    }

    fs_chunks.deleteMany({
      'files_id': {$in : files}
    }, function (error) {
      return cb(error);
    });

    fs_files.deleteMany({
      'metadata.container': containerName
    }, function (error) {
      return cb(error);
    });
  });
};


/**
 * List all files within the given container.
 */
GridFSService.prototype.getFiles = function (containerName, cb) {
  var collection = this.db.collection('fs.files');

  collection.find({
    'metadata.container': containerName
  }).toArray(function (error, container) {
    return cb(error, container);
  });
};


/**
 * Return a file with the given id within the given container.
 */
GridFSService.prototype.getFile = function (containerName, fileId, cb) {
  var collection = this.db.collection('fs.files');

  collection.find({
    '_id': new mongodb.ObjectID(fileId),
    'metadata.container': containerName
  }).limit(1).next(function (error, file) {
    if (!file) {
      error = new Error('File not found');
      error.status = 404;
    }
    return cb(error, file || {});
  });
};


/**
 * Delete an existing file with the given id within the given container.
 */
GridFSService.prototype.deleteFile = function (containerName, fileId, cb) {
  var fs_files = this.db.collection('fs.files');
  var fs_chunks = this.db.collection('fs.chunks');

  fs_files.deleteOne({
    '_id': new mongodb.ObjectID(fileId),
    'metadata.container': containerName
  }, function (error) {
    if (!error) {
      fs_chunks.deleteOne({
        'files_id': new mongodb.ObjectID(fileId)
      }, function(error) {
        cb(error);
      });
    } else {
      cb(error);
    }
  });
};


/**
 * Upload middleware for the HTTP request.
 */
GridFSService.prototype.upload = function (containerName, req, cb) {
  var self = this;

  var busboy = new Busboy({
    headers: req.headers
  });

  busboy.on('file', function (fieldname, file, filename, encoding, mimetype) {
    var options = {
      _id: new mongodb.ObjectID(),
      filename: filename,
      metadata: {
        container: containerName,
        filename: filename,
        mimetype: mimetype
      },
      mode: 'w'
    };

    var gridfs = new GridFS(self.db, mongodb);
    var stream = gridfs.createWriteStream(options);

    stream.on('close', function (file) {
      return cb(null, file);
    });

    stream.on('error', cb);

    file.pipe(stream);
  });

  req.pipe(busboy);
};


/**
 * Download middleware for the HTTP request.
 */
GridFSService.prototype.download = function (containerName, fileId, res, cb) {
  var self = this;

  var collection = this.db.collection('fs.files');

  collection.find({
    '_id': new mongodb.ObjectID(fileId),
    'metadata.container': containerName
  }).limit(1).next(function (error, file) {
    if (!file) {
      error = new Error('File not found.');
      error.status = 404;
    }

    if (error) {
      return cb(error);
    }

    var gridfs = new GridFS(self.db, mongodb);
    var stream = gridfs.createReadStream({
      _id: file._id
    });

    // set headers
    res.set('Content-Type', file.metadata.mimetype);
    res.set('Content-Length', file.length);

    return stream.pipe(res);
  });
};

GridFSService.prototype.downloadContainer = function (containerName, req, res, cb) {
  var self = this;

  var collection = this.db.collection('fs.files');

  collection.find({
    'metadata.container': containerName
  }).toArray(function (error, files) {
    if (files.length === 0) {
      error = new Error('No files to archive.');
      error.status = 404;
    }

    if (error) {
      return cb(error);
    }

    var gridfs = new GridFS(self.db, mongodb);
    var archive = new ZipStream();
    var archiveSize = 0;

    function next() {
      if (files.length > 0) {
        var file = files.pop();
        var fileStream = gridfs.createReadStream({ _id: file._id });

        archive.entry(fileStream, { name: file.filename }, next);
      } else {
        archive.finish();
      }
    }

    next();

    var filename = req.query.filename || 'file';

    res.set('Content-Disposition', `attachment;filename=${filename}.zip`);
    res.set('Content-Type', 'application/zip');

    return archive.pipe(res);
  });
};


GridFSService.modelName = 'storage';

/*
 * Routing options
 */

/*
 * GET /FileContainers
 */
GridFSService.prototype.getContainers.shared = true;
GridFSService.prototype.getContainers.accepts = [];
GridFSService.prototype.getContainers.returns = {
  arg: 'containers',
  type: 'array',
  root: true
};
GridFSService.prototype.getContainers.http = {
  verb: 'get',
  path: '/'
};

/*
 * DELETE /FileContainers/:containerName
 */
GridFSService.prototype.deleteContainer.shared = true;
GridFSService.prototype.deleteContainer.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' }
];
GridFSService.prototype.deleteContainer.returns = {};
GridFSService.prototype.deleteContainer.http = {
  verb: 'delete',
  path: '/:containerName'
};

/*
 * GET /FileContainers/:containerName/files
 */
GridFSService.prototype.getFiles.shared = true;
GridFSService.prototype.getFiles.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' }
];
GridFSService.prototype.getFiles.returns = {
  type: 'array',
  root: true
};
GridFSService.prototype.getFiles.http = {
  verb: 'get',
  path: '/:containerName/files'
};

/*
 * GET /FileContainers/:containerName/files/:fileId
 */
GridFSService.prototype.getFile.shared = true;
GridFSService.prototype.getFile.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' },
  { arg: 'fileId', type: 'string', description: 'File id' }
];
GridFSService.prototype.getFile.returns = {
  type: 'object',
  root: true
};
GridFSService.prototype.getFile.http = {
  verb: 'get',
  path: '/:containerName/files/:fileId'
};

/*
 * DELETE /FileContainers/:containerName/files/:fileId
 */
GridFSService.prototype.deleteFile.shared = true;
GridFSService.prototype.deleteFile.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' },
  { arg: 'fileId', type: 'string', description: 'File id' }
];
GridFSService.prototype.deleteFile.returns = {};
GridFSService.prototype.deleteFile.http = {
  verb: 'delete',
  path: '/:containerName/files/:fileId'
};

/*
 * DELETE /FileContainers/:containerName/upload
 */
GridFSService.prototype.upload.shared = true;
GridFSService.prototype.upload.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' },
  { arg: 'req', type: 'object', http: { source: 'req' } }
];
GridFSService.prototype.upload.returns = {
  arg: 'file',
  type: 'object',
  root: true
};
GridFSService.prototype.upload.http = {
  verb: 'post',
  path: '/:containerName/upload'
};

/*
 * GET /FileContainers/:containerName/download/:fileId
 */
GridFSService.prototype.download.shared = true;
GridFSService.prototype.download.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' },
  { arg: 'fileId', type: 'string', description: 'File id' },
  { arg: 'res', type: 'object', 'http': { source: 'res' } }
];
GridFSService.prototype.download.http = {
  verb: 'get',
  path: '/:containerName/download/:fileId'
};

/*
 * GET /FileContainers/:containerName/download/zip
 */
GridFSService.prototype.downloadContainer.shared = true;
GridFSService.prototype.downloadContainer.accepts = [
  { arg: 'containerName', type: 'string', description: 'Container name' },
  { arg: 'req', type: 'object', 'http': { source: 'req' } },
  { arg: 'res', type: 'object', 'http': { source: 'res' } }
];
GridFSService.prototype.downloadContainer.http = {
  verb: 'get',
  path: '/:containerName/zip'
};
