
var fs = require("fs")
var common = require("./common")
var appFile = common.appFile
var ipfs = common.ipfs
var send_opt = common.send_opt
var contract = common.contract
var iactive = common.iactive
var base = common.base
var logger = common.logger

var socket = require('socket.io-client')('http://localhost:22448')

var task_id, solver, steps

var config

function status(msg) {
    config.message = msg
    socket.emit("config", config)
    logger.info(msg)
}

function solveTask(obj, config) {
    // store into filesystem
    common.initTask(config, obj.file, obj.input, function (inithash) {
        if (inithash == obj.hash) {
            status("Initial hash was correct, now solving.")
        }
        else {
            status("Initial hash was wrong, exiting.")
            process.exit(0)
        }

        common.taskResult(config, function (res) {
            steps = res.steps
            contract.methods.solve(obj.id, res.result, res.steps).send(send_opt, function (err, tr) {
                if (err) logger.error(err)
                else {
                    status("Solved task " + tr)
                    fs.access("blockchain.out", fs.constants.R_OK, function (err) {
                        if (!err) {
                            fs.readFile("blockchain.out", function (err, buf) {
                                if (err) logger.error(err)
                                else appFile.createFile(contract, "task.out", buf, function (id) {
                                    status("Uploaded file " + id.toString(16))
                                    contract.methods.getRoot(id).call(function (err,res) {
                                        logger.info("Output file root", res)
                                    })
                                    common.ensureOutputFile(config, function (proof) {
                                        contract.methods.finalize(obj.id, id, common.getRoots(proof.vm), common.getPointers(proof.vm),
                                                          proof.loc.list, proof.loc.location).send(send_opt, function (err, res) {
                                            logger.info("finalized task", err, res)
                                        })
                                    })
                                })
                            })
                        }
                    })
                }
            })
        })
    })
}

function replyChallenge(id, idx1, idx2) {
    var place = Math.floor((idx2-idx1)/2 + idx1)
    if (idx1 + 1 == idx2) {
        // Now we are sending the intermediate states
        common.getStep(idx1, solver, function (obj) {
            iactive.methods.postPhases(id, idx1, obj.states).send(send_opt, function (err,tx) {
                if (err) logger.error(err)
                else {
                    status("Posted phases " + tx)
                }
            })
        })
        return
    }
    common.getLocation(place, solver, function (hash) {
        iactive.methods.report(id, idx1, idx2, [hash]).send(send_opt, function (err,tx) {
            if (err) logger.error(err)
            else {
                status("Replied place " + place + " for challenge " + tx)
            }
        })
    })
}

function replyFinalityChallenge(id, idx1, idx2) {
    // Now we are sending the intermediate states
    common.getFinality(idx1, solver, function (obj) {
        iactive.methods.callFinalityJudge(id, idx1, obj.location,
                           common.getRoots(obj.vm), common.getPointers(obj.vm)).send(send_opt, function (err, res) {
            if (err) logger.error(err)
            else status("Judging finality " + res)
        })
    })
}

function replyErrorPhases(id, idx1, arr) {
    // Now we are checking the intermediate states
    common.getErrorStep(idx1, solver, function (obj) {
        for (var i = 1; i < obj.states.length; i++) {
            if (obj.states[i] != arr[i]) {
                iactive.methods.selectErrorPhase(id, idx1, arr[i-1], i-1).send(send_opt, function (err,tx) {
                    if (err) logger.error(err)
                    else status("Selected wrong phase " + tx)
                })
                return
            }
        }
        iactive.methods.selectErrorPhase(id, idx1, arr[i-1], i-1).send(send_opt, function (err,tx) {
            if (err) logger.error(err)
            else status("Selected wrong error phase " + tx)
        })
    })
}


function submitProof(id, idx1, phase) {
    // Now we are checking the intermediate states
    common.getStep(idx1, solver, function (obj) {
        var proof = obj[common.phase_table[phase]]
        var merkle = proof.proof || []
        var loc = proof.location || 0
        var m = proof.machine || {reg1:0, reg2:0, reg3:0, ireg:0, vm:"0x00", op:"0x00"}
        if (phase == 5 || phase == 1) m = proof
        var vm 
        if (typeof proof.vm != "object") vm = { code: "0x00", stack:"0x00", call_stack:"0x00", calltable:"0x00",
                               globals : "0x00", memory:"0x00", calltypes:"0x00", input_size:"0x00", input_name:"0x00", input_data:"0x00",
                               pc:0, stack_ptr:0, call_ptr:0, memsize:0}
        else vm = proof.vm
        logger.info("calling judge", {id:id, idx1:idx1, phase:phase, merkle: merkle, vm:m.vm, op:m.op, regs:[m.reg1, m.reg2, m.reg3, m.ireg],
                                     roots:common.getRoots(vm), pointers: common.getPointers(vm), proof:proof})
        iactive.methods.callJudge(id, idx1, phase, merkle, m.vm, m.op, [m.reg1, m.reg2, m.reg3, m.ireg],
                           common.getRoots(vm), common.getPointers(vm)).send(send_opt, function (err, res) {
            if (err) logger.error(err)
            else status("Judging " + res)
        })
    })
}

var challenges = {}

iactive.events.StartChallenge(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (args.p.toLowerCase() != base) return
    logger.error("Got challenge", ev)
    contract.methods.queryChallenge(args.uniq).call(function (err, id) {
        if (err) {
            logger.error(err)
            return
        }
        logger.info("Got task id ", id)
        var id = parseInt(id)
        if (task_id != id) return
        challenges[args.uniq] = {
            prover: args.p,
            task: id,
            challenger: args.c,
            init: args.s,
            result: args.e,
            size: parseInt(args.par),
        }
        replyChallenge(args.uniq, parseInt(args.idx1), parseInt(args.idx2))
    })
})

iactive.events.StartFinalityChallenge(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (args.p.toLowerCase() != base) return
    logger.info("Got finality challenge", args)
    contract.methods.queryChallenge(args.uniq).call(function (err, id) {
        if (err) return logger.error(err)
        logger.info("Got task id ", id)
        var id = parseInt(id)
        if (task_id != id) return
        logger.info("Challenge to us")
        challenges[args.uniq] = {
            prover: args.p,
            task: id,
            challenger: args.c,
            init: args.s,
            result: args.e,
        }
        replyFinalityChallenge(args.uniq, parseInt(args.step))
    })
})

function myId(ev) {
    return !!challenges[ev.returnValues.id]
}

iactive.events.Queried(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (!myId(ev)) return
    logger.info("Query ", args)
    replyChallenge(args.id, parseInt(args.idx1), parseInt(args.idx2))
})

iactive.events.PostedErrorPhases(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (!myId(ev)) return
    logger.info("Error phases ", args)
    replyErrorPhases(args.id, parseInt(args.idx1), args.arr)
})

iactive.events.SelectedPhase(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (!myId(ev)) return
    logger.info("Challenger selected phase ", args)
    submitProof(args.id, parseInt(args.idx1), args.phase)
})

iactive.events.WinnerSelected(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (!myId(ev)) return
    iactive.methods.isRejected(task_id).call(send_opt, function (err, res) {
        if (err) return logger.error(err)
        if (!res) return status("A challenge was rejected")
        status("My solution was rejected, exiting.")
        process.exit(0)
    })
})

contract.events.Finalized(function (err,ev) {
    if (err) return logger.error(err);
    var args = ev.returnValues
    if (task_id.toString() != args.id) return
    status("Task accepted, exiting.")
    process.exit(0)
})

function forceTimeout() {
    if (!config) return
    contract.methods.finalizeTask(task_id).send(send_opt, function (err,tx) {
        if (err) return console.error(err)
        status("Trying timeout " + tx)
    })
}

setInterval(forceTimeout, 10000)

function runSolver(congif) {
    config = congif
    // download file from IPFS
    logger.info("solving", config)
    task_id = parseInt(config.id)
    solver = config
    config.pid = process.pid
    config.kind = "solver"
    config.input_file = "input.bin"
    config.code_file = "task." + common.getExtension(config.code_type)
    socket.emit("config", config)
    common.getFile(config.filehash, config.code_type, function (filestr) {
        common.getAndEnsureInputFile(config, config.inputhash, config.inputfile, filestr, task_id, function (input) {
            solveTask({giver: config.giver, hash: config.hash, file:filestr, filehash:config.filehash, id:task_id, input:input.data, inputhash:input.name}, config)
        })
    })
}

runSolver(JSON.parse(fs.readFileSync("solver.json")))
