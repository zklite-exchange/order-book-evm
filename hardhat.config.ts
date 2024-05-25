import {HardhatUserConfig} from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import {internalTask, extendConfig, task} from 'hardhat/config';
import {TASK_COMPILE_SOLIDITY_READ_FILE} from 'hardhat/builtin-tasks/task-names';
import dotenv from "dotenv";
import * as fs from "fs";
import assert from "node:assert";
dotenv.config();

internalTask(TASK_COMPILE_SOLIDITY_READ_FILE).setAction(
    async (params, hre, runSuper) => {
        if (process.env.SOLIDITY_ENV !== 'debug') {
            const {absolutePath} = params;
            if (absolutePath?.startsWith(hre.config.paths.sources)) {
                let debugBlockStarted = false;
                const lines = fs.readFileSync(absolutePath).toString('utf-8').split(/\r?\n/)
                    .map(line => {
                        if (debugBlockStarted) {
                            if (/\/\/\s*END-DEBUG/.test(line)) {
                                debugBlockStarted = false;
                            }
                            return "";
                        } else if (/\/\/\s*BEGIN-DEBUG/.test(line)) {
                            debugBlockStarted = true;
                            return "";
                        }
                        return line;
                    });
                assert(!debugBlockStarted, "UNMATCHED BEGIN-DEBUG / END-DEBUG");
                return lines.join("\n");
            }
        }
        return runSuper(params)
    }
);

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.26",
        settings: {
            viaIR: true,
            optimizer: {
                enabled: true,
                runs: 2000
            },
        },
    },
    typechain: {
        outDir: "typechain",
        target: "ethers-v6",
    },
    networks: {
        hardhat: {
            chainId: 1337,
        },
    },
    gasReporter: {
        coinmarketcap: process.env.CMC_API_KEY
    }
};
export default config;