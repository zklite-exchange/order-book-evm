import {executeTestScenarios, setUpTest} from "./utils";
import {expect} from "chai";
import {OrderSide} from "../index";

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
        await expect(load.OrderBookContract.connect(load.bob).setMinQuote(load.defaultPairId, 30, 20))
            .to.be.revertedWith("Unauthorized access");
    });

    it("Only admin can set admin", async () => {
        const load = await setUpTest();
        await expect(load.OrderBookContract.connect(load.bob).setAdmin(load.bob.address))
            .to.be.revertedWith("Unauthorized access");
    });

    it("Can't cancel active order of others", async () => {
        const load = await setUpTest();

        await executeTestScenarios(load, [{
            updateAllowance: {from: load.bob, token: load.USDC, amount: 'max'}
        }, {
            submitOrder: {
                alias: 'bobOrder', owner: load.bob, amount: load.fmtUsdc(20), price: load.fmtPrice(1),
                side: OrderSide.BUY
            }
        }, {
            cancelOrder: {
                alias: 'bobOrder', signer: load.alice,
                expectReverted: {
                    message: "Unauthorized"
                }
            }
        }]);
    });
});
