import {setUpTest} from "./utils";
import {expect} from "chai";

describe("OrderBook - Blackbox testing access control", async () => {
    it("Only admin can create pair", async () => {
        const load = await setUpTest();
        await expect(
            load.OrderBookContract.connect(load.bob)
                .createPair(load.wethAddress, load.usdcAddress, 10, 10, 10, 10, 10)
        ).to.be.revertedWith("Unauthorized access");
    });

    it("Only admin can set fee", async () => {
        const load = await setUpTest();
        await expect(
            load.OrderBookContract.connect(load.bob)
                .setFee(load.defaultPairId, 0, 0)
        ).to.be.revertedWith("Unauthorized access");
    });

    it("Only admin can change pair status", async () => {
        const load = await setUpTest();
        await expect(
            load.OrderBookContract.connect(load.bob)
                .setPairActive(load.defaultPairId, false)
        ).to.be.revertedWith("Unauthorized access");
    });

    it("Only admin can set min execute quote", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.admin).setMinQuote(load.defaultPairId, 20, 30))
            .to.not.reverted;
        const pairConf = await load.OrderBookContract.getPair(load.defaultPairId);
        expect(pairConf.minExecuteQuote).eq(20);
        expect(pairConf.minQuoteChargeFee).eq(30);

        await expect(load.OrderBookContract.connect(load.bob).setMinQuote(load.defaultPairId, 30, 20))
            .to.be.revertedWith("Unauthorized access");
    });
});
