import {getImplementationAddress} from "@openzeppelin/upgrades-core/dist/eip-1967";
import {task} from "hardhat/config";

export const OrderBookContractName = "zkLite Order Book";
export const OrderBookContractVersion = "v1";

task("deployOrderBook", async (_, hre) => {
    const {deployProxy, hreAccounts} = await import("./utils");
    const [adminWallet] = await hreAccounts();
    const contractInstance = await deployProxy(adminWallet, "OrderBook", {
        constructorArgs: [OrderBookContractName, OrderBookContractVersion],
        initArgs: [adminWallet.address],
        initializer: "initV1"
    });
    const proxyAddress = await contractInstance.getAddress();
    console.log(
        `Deployed OrderBook contract on ${hre.network.name}: ${proxyAddress}`,
        `\nAdmin wallet: ${adminWallet.address}`,
        `\nTx: ${contractInstance.deploymentTransaction()?.hash}`
    );
    const implAddress = await getImplementationAddress(hre.network.provider, proxyAddress);
    console.log(`Impl address: ${implAddress}`);
});

task("verifyOrderBook", async (taskArgs: any, hre) => {
    if (!taskArgs.address) {
        console.log("Missing address arg");
        process.exit(1);
    }
    await hre.run("verify:verify", {
        address: taskArgs.address,
        constructorArguments: [OrderBookContractName, OrderBookContractVersion],
        ...(hre.network.zksync && {
            contract: "contracts/OrderBook.sol:OrderBook",
        })
    });
}).addParam("address", "Address to verify");
