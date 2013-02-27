
const ASSERT = require("assert");
const PATH = require("path");
const URL = require("url");
const FS = require("fs-extra");
const DEEPMERGE = require("deepmerge");
// TODO: Make `jsonlint` optional (too many dependencies for what we get).
const JSONLINT = require("jsonlint");
const MAPPINGS = require("mappings");


var instances = {};

exports.forProgram = function(options) {
	if (typeof options === "string") {
		options = {
			CWD: options
		};
	} else {
		if (typeof options === "object" && typeof options.filename !== "undefined") {
			options = {
				CWD: exports.findDescriptor(PATH.dirname(options.filename), "package.json") || process.cwd()
			};
		}
	}
	return function(module, ns) {
		try {
			return new PINF(options, module, ns);
		} catch(err) {
			console.error(err.stack);
			throw err;
		}
	};
}

exports.for = exports.forProgram({
	CWD: process.cwd(),
	PINF_PROGRAM: process.env.PINF_PROGRAM,
	PINF_PACKAGE: process.env.PINF_PACKAGE,
	PINF_MODE: process.env.PINF_MODE
});


exports.uriToPath = function(uri) {
	return uri.replace(/[:@#]/g, "/").replace(/[\?&=]/g, "+").replace(/\/+/g, "/").replace(/\/$/, "+");
}

exports.uriToFilename = function(uri) {
	return exports.uriToPath(uri).replace(/\//g, "+");
}

exports.formatUid = function(uri) {
	if (!uri) return false;
	var parsedUri = URL.parse(uri);
	if (parsedUri) {
		uri = ((parsedUri.hostname)?parsedUri.hostname:"") + parsedUri.pathname;
	}
	return uri;
}

exports.findDescriptor = function(packagePath, basename) {
	var descriptorPath = PATH.join(packagePath, basename);
	while (!FS.existsSync(descriptorPath)) {
		var newPath = PATH.join(descriptorPath, "../..", PATH.basename(descriptorPath));
		if (newPath === descriptorPath) return false;
		descriptorPath = newPath;
		if (FS.existsSync(descriptorPath)) {
			break;
		}
	}
	return descriptorPath;
}


var PINF = function(options, module, ns) {
	var self = this;

	if (typeof options.strict === "undefined") {
		options.strict = true;
	}

	self.debug = options.debug || false;

	self.ENV = {};
	for (var name in process.env) {
		self.ENV[name] = process.env[name];
	}
	ASSERT(typeof options.PINF_PROGRAM !== "undefined" || typeof options.CWD !== "undefined");
	// These environment variables declare what to boot and in which state:
	//   * A local filesystem path to a `program.json` file (how to boot).
	self.ENV.PINF_PROGRAM = options.PINF_PROGRAM || PATH.join(options.CWD, "program.json");
	//   * A local filesystem path to a `package.json` file (what to boot).
	self.ENV.PINF_PACKAGE = options.PINF_PACKAGE || PATH.join(options.CWD, "package.json");
	//   * A local filesystem path to a `program.rt.json` file (the state to boot in).
	self.ENV.PINF_RUNTIME = PATH.join(self.ENV.PINF_PROGRAM, "../.rt/program.rt.json");
	//   * The mode the runtime should run it. Will load `program.$PINF_MODE.json`.
	self.ENV.PINF_MODE = options.PINF_MODE || "production";

	if (typeof module === "string") {
		self.module = {
			dirname: module
		};
		module = self.module;
	} else {
		self.module = module;
	}

	module.pinf = DEEPMERGE(module.pinf || {}, {
		iid: "singleton",
		uid: null,
		ns: {
			filename: null,
			config: null,
			env: null,
			api: null
		},
		paths: {
			runtime: self.ENV.PINF_RUNTIME,
			program: self.ENV.PINF_PROGRAM,
			package: null,
			data: null,
			conf: null,
			log: null,
			pid: null,
			cache: null,
			tmp: null
		},
		env: {},
		config: {},
		packages: {},
		main: false
	});

	var packagePath = null;
	if (module.dirname) {
		packagePath = module.dirname;
	} else
	if (module.filename) {
		packagePath = PATH.dirname(module.filename);
	} else {
		throw new Error("Cannot determine package path.");
	}

	var packageDescriptorPath = exports.findDescriptor(packagePath, "package.json");
	if (!packageDescriptorPath) {
		throw new Error("No `package.json` found for path '" + packagePath + "'");
	}

	module.pinf.paths.package = PATH.dirname(packageDescriptorPath);

	function loadJSON(path, onFoundCallback) {

		if (self.debug) console.log("[sm] Load JSON from '" + path + "'.");

		if (!FS.existsSync(path)) {
			if (self.debug) console.log("[sm] WARN: Path '" + path + "' does not exist.");
			return null;
		}
		function onFound(obj) {
			return onFoundCallback(obj);
		}
		try {
			var json = FS.readFileSync(path).toString();
			// Replace environment variables.
            // NOTE: We always replace `$__DIRNAME` with the path to the directory holding the descriptor.
            json = json.replace(/\$__DIRNAME/g, PATH.dirname(path));
			if (self.debug) console.log("[sm] JSON from '" + path + "': ", json);

			var obj = JSON.parse(json);
			if (!obj) return obj;

			var injectedEnv = null;
			var extending = null;
			if (Array.isArray(obj.env) && obj.env[0] === "<-") {
				// TODO: Support URLs.
				var injectPath = PATH.join((FS.realpathSync || PATH.realpathSync)(path), ".." , obj.env[1]);
				obj.env = injectedEnv = {};
				loadJSON(injectPath, function(injectObj) {	
					obj.env = injectedEnv = injectObj || false;
				});
			}

			if (obj.extends) {
				obj.extends.forEach(function(uri) {
					var extendsPath = false;
					if (/^\//.test(uri)) {
						// We allow absolute extends paths in platform config files (prefixed with `.`).
						if (/^\./.test(PATH.basename(path))) {
							extendsPath = uri;
						} else {
							throw new Error("`extends` uri '" + uri + "' may not be an absolute path in '" + path + "'.");
						}
					} else {
						var extendsPath = PATH.join(
							PATH.dirname(path),
							(descriptor.directories && descriptor.directories.packages) || "node_modules",
							uri,
							PATH.basename(path).replace(".json", ".prototype.json")
						);
						if (!FS.existsSync(extendsPath)) {
							extendsPath = PATH.join((FS.realpathSync || PATH.realpathSync)(path), ".." , uri);
						}
					}
					// TODO: Support URLs.
					loadJSON(extendsPath, function(extendsObj) {
						if (extendsObj) {
							extending = DEEPMERGE(extendsObj, extending || {});
							obj = DEEPMERGE(extendsObj, obj);
						}
					});
				});
			}

			if (obj.env) {
				for (var name in obj.env) {
					if (("$" + name) !== obj.env[name]) {
						self.ENV[name] = obj.env[name];
					}
				}
			}

			// TODO: Replace by looping through `process.env` rather than the other way around.
			var m = json.match(/\$([A-Z]{1}[A-Z0-9_]*)/g);
			if (m) {
				m.forEach(function(name) {
					if (typeof self.ENV[name.substring(1)] !== "string") {
						if (options.strict) {
							console.error("self.ENV", self.ENV);
							throw new Error("The '" + name.substring(1) + "' environment variable must be set!");
						} else {
							// Don't replace. We assume it is not needed otherwise `options.strict`should be set.
						}
					} else {
						json = json.replace(new RegExp("\\" + name, "g"), self.ENV[name.substring(1)]);
					}
				});
			}
			obj = JSON.parse(json);
			if (obj && injectedEnv) {
				obj.env = injectedEnv;
			}
			if (extending) {
				obj = DEEPMERGE(extending, obj);
			}

			if (obj && onFound) onFound(obj);
			return obj;
		} catch(err) {
			try {
				JSONLINT.parse(json);
			} catch(err) {
				err.message += " (while parsing '" + path + "')";
				throw err;
			}
			err.message += " (while parsing '" + path + "')";
			throw err;
		}
	}

	function insertNamespace(obj, property, ns) {
		if (typeof obj[property] !== "undefined") {
			var value = obj[property];
			obj[property] = {};
			obj[property][ns] = value;
		}
	}

	// Precedence:
	var descriptor = {};
	var packageUid = false;
	//   6) ./package.json
	loadJSON(packageDescriptorPath, function(obj) {
		insertNamespace(obj, "config", ".");
//		insertNamespace(obj, "env", ".");
		descriptor = DEEPMERGE(descriptor, obj);
		packageUid = exports.formatUid(descriptor.uid);
	});
	//   5) /program.json
	loadJSON(self.ENV.PINF_PROGRAM, function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});
	//   4) ./.package.json
	loadJSON(packageDescriptorPath.replace(/\/([^\/]*)$/, "\/.$1"), function(obj) {
		insertNamespace(obj, "config", ".");
//		insertNamespace(obj, "env", ".");
		descriptor = DEEPMERGE(descriptor, obj);
		packageUid = exports.formatUid(descriptor.uid) || packageUid;
	});
	//   3) /.program.json
	loadJSON(self.ENV.PINF_PROGRAM.replace(/\/([^\/]*)$/, "\/.$1"), function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});
	//   2) /.rt/program.rt.json
	//		The `rt` descriptor holds the runtime information for this instance of the program. There can always
	//		only be one runtime instance of a program installation. If you want to boot a second, create an
	//		inheriting program descriptor in a new directory and boot it there.
	loadJSON(self.ENV.PINF_RUNTIME, function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});
	//   1) /program.$PINF_MODE.json
	loadJSON(self.ENV.PINF_PROGRAM.replace(".json", "." + self.ENV.PINF_MODE + ".json"), function(obj) {
		descriptor = DEEPMERGE(descriptor, obj);
	});

	module.pinf.uid = exports.formatUid(module.pinf.uid || packageUid) || exports.uriToFilename(PATH.dirname(packageDescriptorPath));
	module.pinf.ns.filename = module.pinf.ns.filename || exports.uriToFilename(module.pinf.uid + "+" + module.pinf.iid);
	module.pinf.ns.config = module.pinf.ns.config || packageUid || ".";
	module.pinf.ns.env = module.pinf.ns.env || module.pinf.ns.config;
	module.pinf.ns.api = module.pinf.ns.api || module.pinf.ns.config;
	module.pinf.main = descriptor.main || false;
	module.pinf.env = self.ENV;
	[
		"mappings",
		"devMappings",
		"optionalMappings",
		"dependencies",
		"devDependencies",
		"optionalDependencies"
	].forEach(function(attributeName) {
		if (!descriptor[attributeName]) return;
		function detect(name, locator) {
			if (name === "*" && locator === "*") {
				module.pinf.packages["*"] = "*";
			} else {
				var path = 
				module.pinf.packages[name] = PATH.join(
					module.pinf.paths.package,
					(descriptor.directories && descriptor.directories.packages) || "node_modules",
					name
				);
			}
		}
		if (Array.isArray(descriptor[attributeName])) {
			descriptor[attributeName].forEach(detect);
		} else {
			for (var name in descriptor[attributeName]) {
				detect(name, descriptor[attributeName][name]);
			}
		}
	});

	Object.keys(module.pinf.paths).forEach(function(type) {
		if (module.pinf.paths[type]) return;
		if (descriptor.directories && descriptor.directories[type]) {
			module.pinf.paths[type] = PATH.resolve(packageDescriptorPath, descriptor.directories[type]);
		} else {
			module.pinf.paths[type] = PATH.join(self.ENV.PINF_RUNTIME, "..", type, module.pinf.ns.filename);
		}
	});

	function mergePropertyFor(name, ns) {
		if (
			descriptor &&
			descriptor[name] &&
			descriptor[name][ns]
		) {
			module.pinf[name] = DEEPMERGE(module.pinf[name] || {}, descriptor[name][ns]);
		}
	}

	// Precedence:
	//   3) Referenced by `.`.
	mergePropertyFor("config", ".");
	mergePropertyFor("env", ".");
	//   2) Referenced by `uid`.
	mergePropertyFor("config", module.pinf.uid);
	mergePropertyFor("env", module.pinf.uid);
	//   1) Referenced by `ns.*`.
	if (ns) {
		// If `ns` is array, load all namespaces.
		if (ns.indexOf("/") === -1) {
			var properties = [
				"mappings",
				"optionalMappings",
				"devMappings"
			];
			for (var i=0; i<properties.length ; i++) {
				if (descriptor[properties[i]][ns] && typeof descriptor[properties[i]][ns] === "string") {
					var parsedUri = URL.parse("http://" + descriptor[properties[i]][ns]);
					if (parsedUri.hostname && !/\/$/.test(parsedUri.pathname)) {
						ns = parsedUri.hostname + PATH.dirname(parsedUri.pathname) + "/";
						break;
					}
				}
			}
		}
		mergePropertyFor("config", ns);
		mergePropertyFor("config", ns + "0");
		mergePropertyFor("env", ns);
	} else {
		if (module.pinf.ns && module.pinf.ns.config) {
			mergePropertyFor("config", module.pinf.ns.config);
			// TODO: Add proper semver based matching of config rules with versions against package version.
			mergePropertyFor("config", module.pinf.ns.config + "0");
		}
		if (module.pinf.ns && module.pinf.ns.env) {
			mergePropertyFor("env", module.pinf.ns.env);
		}
	}

	self._credentials = descriptor.credentials || {};
}

PINF.prototype.config = function(extra) {
	var config = DEEPMERGE(this.module.pinf.config || {}, extra || {});
	config.pinf = this.module.pinf;
	return config;
}

PINF.prototype.credentials = function() {
	return this._credentials;
}

PINF.prototype.path = function(options, type, subpath, filename) {
	if (!options.pinf) {
		throw new Error("`options` does not contain a `pinf` property.");
	}
	if (!options.pinf.paths[type]) {
		throw new Error("Path for type '" + type + "' not found for package: " + options.pinf.paths.package);
	}
	var path = PATH.join(options.pinf.paths[type], subpath);
	if (!FS.existsSync(path)) {
		FS.mkdirsSync(path);
	}
	return PATH.join(path, filename);
}

// One instance for a given package per program (multiple via iid).
// NOTE: This function may take a while to return depending on the number of runtimes
//		 to sync across, their distance, and db used to sync.
PINF.prototype.singleton = function(config, constructor, callback) {
	var self = this;
	var id = [
	    config.pinf.uid,
	    config.pinf.iid
	].join(":");
	// TODO: Keep track of instance across processes. i.e. only one process per `uid : iid`
	function finalize(callback) {
		return callback(null, instances[self.ENV.PINF_RUNTIME][id]);
	}
	if (!instances[self.ENV.PINF_RUNTIME] || !instances[self.ENV.PINF_RUNTIME][id]) {
		try {
			var Instance = function() {
				this.config = config;
			}
			Instance.prototype = new constructor();
			Instance.prototype.anchorInstance = function(anchor, callback) {

//	console.log("SET PID OF PROCESS", anchor);
	// TODO: Attach instance pointer to persistant storage (local fs, central db, etc...)
				return callback(null);
			}
			if (!instances[self.ENV.PINF_RUNTIME]) instances[self.ENV.PINF_RUNTIME] = {};
			instances[self.ENV.PINF_RUNTIME][id] = new Instance();
			instances[self.ENV.PINF_RUNTIME][id].__construct(function(err) {
				if (err) return callback(err);

//console.log("got init");
				// TODO: Save config so it gets loaded for other clients and in future.

				return finalize(callback);
			});
		} catch(err) {
			return callback(err);
		}
	} else {
		return finalize(callback);
	}
}

PINF.prototype.resolve = function(id, callback) {
	return sm(this, function(err, SM) {
		if (err) return callback(err);
		return SM.resolve(id, callback);
	});
}
PINF.prototype.resolveSync = function(id) {
	return MAPPINGS.for(this.module.pinf.paths.package).resolve(id, silence);
}
PINF.prototype.require = function(id, callback) {
	return sm(this, function(err, SM) {
		if (err) return callback(err);
		return SM.require(id, callback);
	});
}

PINF.prototype.run = function(program) {
	function error(err) {
		if (err && typeof err === "object") {
			console.error(err.stack);
		}
		process.exit(1);
	}
	try {
		program(function(err) {
			if (err) return error(err);
			process.exit(0);
		});
	} catch(err) {
		return error(err);
	}
}


function sm(instance, callback) {
	ASSERT(typeof process.env.SM_BIN_PATH === "string", "The 'SM_BIN_PATH' environment variable must be set!")
	try {
		return callback(null, require(PATH.join(FS.realpathSync(process.env.SM_BIN_PATH), "../../lib/sm.js")).for(instance.module.pinf.paths.package, {
			verbose: !!process.env.SM_VERBOSE,
			debug: !!process.env.SM_DEBUG,
			now: process.env.SM_NOW ? process.env.SM_NOW : false
		}));
	} catch(err) {
		return callback(err);
	}
}
