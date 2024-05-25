import hre from "hardhat";

export async function deployFakeTokens(owner: any) {
    const WETH = await hre.ethers.deployContract("WETH", owner);
    const USDC = await hre.ethers.deployContract("USDC", owner);
    return {
        WETH, USDC
    }
}