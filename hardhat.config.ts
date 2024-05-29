import {HardhatUserConfig} from "hardhat/config";
import "zksync-ethers";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import "@matterlabs/hardhat-zksync-ethers";
import dotenv from "dotenv";
import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-node";
import "solidity-coverage";
import "hardhat-gas-reporter";

dotenv.config();

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.26",
        settings: {
            viaIR: true,
            evmVersion: "cancun",
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