import {HardhatUserConfig} from "hardhat/config";
import "zksync-ethers";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@matterlabs/hardhat-zksync-ethers";
import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-node";
import '@openzeppelin/hardhat-upgrades';
import "solidity-coverage";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import dotenv from "dotenv";
dotenv.config();


const TEST_ZKSYNC = process.env.ZKSYNC_NODE === "1";

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
        version: "1.4.1", // Uses latest available in https://github.com/matter-labs/zksolc-bin/
        settings: {
            optimizer: {
                enabled: true,
                mode: 'z' // even worse if mode = 3
            }
        }
    },
    networks: {
        hardhat: {
            zksync: TEST_ZKSYNC,
        },
        zkSyncSepoliaTestnet: {
            url: "https://sepolia.era.zksync.dev",
            ethNetwork: "sepolia",
            zksync: true,
            chainId: 300,
            // @ts-expect-error unknown
            verifyURL: "https://explorer.sepolia.era.zksync.dev/contract_verification",
        },
        zkSyncMainnet: {
            url: "https://mainnet.era.zksync.io",
            ethNetwork: "mainnet",
            zksync: true,
            // @ts-expect-error unknown
            verifyURL: "https://zksync2-mainnet-explorer.zksync.io/contract_verification",
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
};
export default config;
