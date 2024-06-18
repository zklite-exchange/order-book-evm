import {setUpTest} from "./utils";
import {expect} from "chai";
import {getImplementationAddress} from "@openzeppelin/upgrades-core/dist/eip-1967";
import hre from "hardhat";
import {upgradeProxy} from "../scripts/utils";

describe("OrderBook - test upgradable", async () => {
    it("Test upgrade", async () => {
        const load = await setUpTest();
        const testName = "NameV2";
        const testVersion = "v2";
        const oldImpl = await getImplementationAddress(hre.network.provider, await load.OrderBookContract.getAddress());
        expect(oldImpl).not.empty;
        console.log(`Old impl = ${oldImpl}`);
        await upgradeProxy(load.admin, "OrderBookUpgradeTest", load.OrderBookContract, {
            constructorArgs: [testName, testVersion],
            call: {
                fn: "onUpgrade",
                args: []
            }
        });
        const newImpl = await getImplementationAddress(hre.network.provider, await load.OrderBookContract.getAddress());
        console.log(`New impl = ${newImpl}`);
        expect(oldImpl).not.eq(newImpl);
        expect(await load.OrderBookContract.getName()).eq(testName);
        expect(await load.OrderBookContract.getVersion()).eq(testVersion);
    });
});
