import {HardhatUserConfig, task} from "hardhat/config";
import "@typechain/hardhat";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";
import "@matterlabs/hardhat-zksync-ethers";
import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-node";
// noinspection ES6UnusedImports
import type {} from "@openzeppelin/hardhat-upgrades";
import "hardhat-contract-sizer";
import "zksync-ethers";
import dotenv from "dotenv";
import {TASK_TEST} from "hardhat/builtin-tasks/task-names";
import {
    configureNetwork,
    constructCommandArgs,
    getAvailablePort,
    waitForNodeToBeReady
} from "@matterlabs/hardhat-zksync-node/dist/utils";
import {ZkSyncNodePluginError} from "@matterlabs/hardhat-zksync-node/dist/errors";
import {START_PORT, TASK_NODE_ZKSYNC_DOWNLOAD_BINARY} from "@matterlabs/hardhat-zksync-node/dist/constants";
import {JsonRpcServer} from "@matterlabs/hardhat-zksync-node/dist/server";
import "./scripts/deploy";

dotenv.config();

const networkMatcher = /--network\s*=?\s*(\w+)/.exec(process.argv.join(" "));
const isZkSync = networkMatcher && networkMatcher[1]?.startsWith("zkSync");

if (isZkSync) {
    require("@matterlabs/hardhat-zksync-verify");
    require("@matterlabs/hardhat-zksync-upgradable");
} else {
    require("@openzeppelin/hardhat-upgrades");
    require("hardhat-gas-reporter");
    require("solidity-coverage");
}

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.25",
        settings: {
            viaIR: true,
            evmVersion: "cancun",
            optimizer: {
                enabled: true,
                runs: 2000
            },
        },
    },
    zksolc: {
        version: "1.5.0", // Uses latest available in https://github.com/matter-labs/zksolc-bin/
        settings: {
            optimizer: {
                enabled: true,
                mode: "3"
            }
        }
    },
    defender: {
        apiKey: process.env.DEFENDER_KEY as string,
        apiSecret: process.env.DEFENDER_SECRET as string,
    },
    networks: {
        hardhat: {},
        zkSyncMemoryNode: {
            url: `http://localhost:${START_PORT}`,
            zksync: true,
            // @ts-ignore
            inMemory: true
        },
        zkSyncSepoliaTestnet: {
            url: "https://sepolia.era.zksync.dev",
            ethNetwork: "sepolia",
            zksync: true,
            // @ts-ignore
            verifyURL: "https://explorer.sepolia.era.zksync.dev/contract_verification",
            accounts: [`${process.env.ZKSYNC_SEPOLIA_PK1}`, `${process.env.ZKSYNC_SEPOLIA_PK2}`],
        },
        zkSyncMainnet: {
            url: "https://mainnet.era.zksync.io",
            ethNetwork: "mainnet",
            zksync: true,
            // @ts-ignore
            verifyURL: "https://zksync2-mainnet-explorer.zksync.io/contract_verification",
        },
        sepolia: {
            chainId: 11155111,
            url: `https://sepolia.infura.io/v3/${process.env.INFURA_KEY}`,
            accounts: [`${process.env.ZKSYNC_SEPOLIA_PK1}`, `${process.env.ZKSYNC_SEPOLIA_PK2}`],
        },
    },
    gasReporter: {
        enabled: true,
        coinmarketcap: process.env.CMC_API_KEY
    },
    contractSizer: {
        runOnCompile: true,
    },
    typechain: {
        outDir: "typechain",
        target: "ethers-v6",
    },
    etherscan: {
        apiKey: process.env.ETHERSCAN_KEY,
    }
};

export default config;

// ZKSYNC WORKAROUND

task(TASK_TEST).setAction(
    async (
        taskArgs,
        env,
        runSuper,
    ) => {
        if (!env.network.zksync || !(env.network as any).config.inMemory) {
            return await runSuper(taskArgs);
        }

        // Download the binary, if necessary
        const binaryPath: string = await env.run(TASK_NODE_ZKSYNC_DOWNLOAD_BINARY, {force: false});

        const currentPort = await getAvailablePort(START_PORT, 1);
        const commandArgs = constructCommandArgs({port: currentPort});

        const server = new JsonRpcServer(binaryPath);

        try {
            await server.listen(commandArgs, false);

            await waitForNodeToBeReady(currentPort);
            configureNetwork(env.network, currentPort);

            let testFailures = 0;
            try {
                // Run the tests
                testFailures = await runSuper(taskArgs);
            } finally {
                await server.stop();
            }

            process.exitCode = testFailures;
            return testFailures;
        } catch (error: any) {
            throw new ZkSyncNodePluginError(`Failed when running node: ${error.message}`);
        }
    },
);

