import {SetupService} from '../../src/service/setup.js';
import {startServer} from '../../src/server.js';
// Isolate the uninitialized listener from any local service using port 3000.
const setup=new SetupService();setup.bootstrap.port=Number(process.argv[2]);setup.bootstrap.host='127.0.0.1';
startServer(setup);
